import { Api, MAX_LIST_ITEMS, type CallOptions, type CardOut } from './api.js'
import { encodeAddress } from './bech32.js'
import { hex32, lessThan, toHex } from './bytes.js'
import { isSpenderType, subnameOf } from './cards.js'
import { mapLimitDistinct, withDeadline, DERIVE_CHUNK, checkTimeout, yieldNow } from './deadline.js'
import { ANSWERED, ConfigError, ApiError, InvalidNameError, NodeError, RefutedError, SubnameError } from './errors.js'
import { deploymentFor, directoryFor } from './deployments.js'
import { type Params, type Registry, feeForName, loadRegistry } from './manifest.js'
import * as names from './names.js'
import type { Node } from './node.js'
import { type Owner, ownerAddress, ownerOfParsed, parseAddress } from './owner.js'
import {
  type NodeContext,
  cardOf,
  deedAddressOf,
  deedOrder,
  markPrimary,
  probe,
  proveRows,
  recordsOfCard,
} from './proof.js'
import { OwnerType, encodeGapState, encodePendingDeedState, isOwnerType } from './state.js'

import type {
  DotkOptions,
  Resolved,
  Card,
  Lookup,
  History,
  OwnedName,
  Quote,
  Subname,
  Classified,
  RecipientSubname,
  Recipient,
  Health,
} from './answers.js'

export type {
  DotkOptions,
  Resolved,
  Card,
  Lookup,
  History,
  OwnedName,
  Quote,
  Subname,
  ClassifiedName,
  ClassifiedSubname,
  ClassifiedAddress,
  ClassifiedNeither,
  Classified,
  RecipientAddress,
  RecipientName,
  RecipientSubname,
  RecipientSubnameUnresolved,
  RecipientNeither,
  Recipient,
  Health,
} from './answers.js'

/** How long a call can take before this package abandons it, when the caller sets no deadline. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** How many API requests a batch call has in flight at once. */
export const DEFAULT_CONCURRENCY = 6

/**
 * The order this package lists an address's names in: shortest first, then alphabetically.
 *
 * Bare names are ASCII, so length is byte length, and no two names in a registry are equal.
 * Those two facts make this a total order, and therefore the same order everywhere. See
 * {@link Dotk.displayNameFor}.
 */
export function displayOrder(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Read a value the API supplied. Anything malformed becomes an {@link ApiError}.
 *
 * The derivations throw `TypeError` for bytes that are not bytes, and `InvalidNameError` for a
 * name that cannot be one. Those are right for a value the caller supplied and wrong for one the
 * API supplied, because the caller can only pick another API.
 */
function fromApi<T>(what: string, read: () => T): T {
  try {
    return read()
  } catch (e) {
    // A refusal this package already worded, such as a list past its cap, goes up as it is.
    if (e instanceof ApiError) throw e
    throw new ApiError(
      `the API answered with an unusable ${what}: ${e instanceof Error ? e.message : String(e)}`,
      ANSWERED,
      undefined,
      undefined,
      e
    )
  }
}

/**
 * A list out of one API answer, refused past {@link MAX_LIST_ITEMS}. Every item costs a
 * derivation here and a node request with a node, so an answer chooses how much work this
 * package does, and the cap is what bounds that choice.
 */
function bounded<T>(list: readonly T[], what: string): readonly T[] {
  if (list.length > MAX_LIST_ITEMS)
    throw new ApiError(
      `the API answered with ${list.length} ${what}, past the ${MAX_LIST_ITEMS} this package reads`,
      ANSWERED
    )
  return list
}

/**
 * A read-only client of one registry. Every name argument can be what a user typed
 * (`" Kaspa.K "`, `"KASPA"`, `"kaspa.k"`), and every address must be on the registry's network.
 */
export class Dotk {
  readonly network: string
  readonly registryCovenantId: string
  readonly api: Api | undefined
  readonly node: Node | undefined
  private readonly registry: Registry
  private readonly timeoutMs: number | null
  private readonly concurrency: number

  constructor(options: DotkOptions = {}) {
    this.registry = loadRegistry(options.genesis ?? deploymentFor(options.network))
    this.network = options.network ?? this.registry.network
    // The network id, not its address prefix. Every `testnet-*` shares one prefix, so a prefix
    // comparison admits a sibling chain the registry is not on.
    if (this.network !== this.registry.network) {
      throw new ConfigError(`this package addresses the registry on ${this.registry.network}, not ${this.network}`)
    }
    this.registryCovenantId = this.registry.registryCovenantId
    this.timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : checkTimeout(options.timeoutMs)
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
    // Refused and not clamped: a batch run with a nonsense width fills no slot and answers every
    // name null, which looks like a registry that holds none of them.
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1)
      throw new ConfigError(`concurrency must be a whole number of requests, at least 1, not ${options.concurrency}`)
    this.api =
      options.api === null
        ? undefined
        : new Api({
            base: options.api ?? directoryFor(this.registry.network),
            registryCovenantId: this.registryCovenantId,
            fetch: options.fetch,
            timeoutMs: this.timeoutMs,
          })
    this.node = options.node
  }

  /** The bech32 prefix of every address this registry uses. */
  get prefix(): string {
    return this.registry.prefix
  }

  /** The deployment's economic constants, as the compiler baked them into the covenants. */
  get params(): Params {
    return this.registry.params
  }

  /**
   * What registering a name costs, in sompi. Pure: it asks nothing of the API or the node.
   *
   * The figures are the deployment's own, so this is what the covenant will demand. It leaves
   * out the network fee, which depends on a transaction that does not exist yet, and it says
   * nothing about whether the name is free. Ask {@link available} for that.
   */
  quote(name: string): Quote {
    const bare = this.normalize(name)
    const p = this.registry.params
    const fee = feeForName(p, bare)
    const lockedValue = p.bond + p.gap_value
    return {
      name: bare,
      fee,
      bond: p.bond,
      deposit: p.deposit,
      gapValue: p.gap_value,
      lockedValue,
      totalToFund: lockedValue + Math.max(fee, p.deposit),
    }
  }

  /**
   * The loaded registry: its identity, params and covenant templates.
   *
   * Here for `@dotk/sdk-tx`, which derives the redeem scripts a covenant spend carries. A reader
   * has no use for it, and the bundled manifest pins everything under it.
   */
  get protocol(): Registry {
    return this.registry
  }

  /**
   * What a person typed: a name, a subname, an address on this registry's network, or neither
   * with the reason why. It asks nothing of the API or the node, and it throws nothing.
   *
   * A recipient field needs this first, because the cases go different ways. The caller pays an
   * address as it stands, resolves a name through {@link addressFor}, and a subname through
   * {@link payeeFor}. {@link recipientFor} runs this and the call for the kind in one step.
   *
   * The subname arm names the parent as `parent`, so a caller that pays `addressFor(c.name)` on
   * the name arm cannot pay a parent's owner for a subname. Code that handles `name` and
   * `address` and treats the rest as neither refuses a subname, which is the safe default.
   */
  classify(input: string): Classified {
    // A recipient field's value comes from the DOM or from a caller with no types, so a
    // non-string is ordinary here. This call never throws.
    const given: unknown = input
    if (typeof given !== 'string') {
      return { kind: 'neither', reason: `expected text, got ${given === null ? 'null' : typeof given}` }
    }
    const typed = input.trim()
    if (typed.includes(':')) {
      try {
        const parsed = parseAddress(typed, this.prefix)
        return { kind: 'address', address: encodeAddress(parsed.prefix, parsed.version, parsed.payload) }
      } catch (e) {
        return { kind: 'neither', reason: e instanceof Error ? e.message : String(e) }
      }
    }
    // A dotted input goes through subname rule 1, which is the only reader of a label.
    if (typed.includes('.')) {
      const answer = dotted(typed)
      if ('reason' in answer) return { kind: 'neither', reason: answer.reason }
      const { parent, label } = answer
      if (label === null) return { kind: 'name', name: parent, display: names.display(parent) }
      return { kind: 'subname', parent, label, display: `${label}.${names.display(parent)}` }
    }
    try {
      const name = this.normalize(typed)
      return { kind: 'name', name, display: names.display(name) }
    } catch (e) {
      return { kind: 'neither', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /** The bare on-chain spelling of a typed name. Throws {@link InvalidNameError} when it cannot be one. */
  normalize(input: string): string {
    const name = names.normalize(input)
    // A dot survives the stripped suffix in two cases. One is a subname, and the other is an
    // input that carries no suffix. Only the first has another call to send the caller to.
    if (name.includes('.')) {
      const answer = dotted(input)
      if ('reason' in answer) throw new InvalidNameError(answer.reason)
      if (answer.label !== null) {
        // The canonical form, so the message names what this call read.
        const display = `${answer.label}.${names.display(answer.parent)}`
        throw new InvalidNameError(
          `${JSON.stringify(display)} is a subname, and this call answers a name. Use resolveSubname or payeeFor`
        )
      }
    }
    names.validate(name)
    return name
  }

  /** How readers show a typed name. This normalizes the name and appends the `.k` suffix. */
  display(name: string): string {
    return names.display(this.normalize(name))
  }

  /** The name key, `blake3(name)` as hex. */
  keyOf(name: string): string {
    return toHex(names.keyBytesOf(this.normalize(name)))
  }

  /** The owner record a deed stores for this address. */
  ownerOf(address: string): Owner {
    const { ownerType, owner } = ownerOfParsed(parseAddress(address, this.prefix))
    return { ownerType, owner: toHex(owner) }
  }

  /** The address the deed of `name` sits at if `address` owns it. Pure: it asks nothing. */
  deedAddress(name: string, address: string): string {
    const { ownerType, owner } = ownerOfParsed(parseAddress(address, this.prefix))
    return deedAddressOf(this.registry, this.normalize(name), ownerType, owner)
  }

  /** Whether the node holds the deed of `name` owned by `address`. Throws without a node. */
  async verify(name: string, address: string, options?: CallOptions): Promise<boolean> {
    const deed = this.deedAddress(name, address)
    return (await probe(this.nodeContext(), [deed], options)).has(deed)
  }

  /** Who owns a name, or null when nobody does. Needs the API. The node proves it when the caller gave one. */
  async resolveName(name: string, options?: CallOptions): Promise<Resolved | null> {
    return (await this.resolveMany([name], options))[0]!
  }

  /**
   * {@link resolveName} for every name. The answer holds one slot for each name you passed.
   *
   * This asks the API once per name, `DotkOptions.concurrency` at a time, and then asks
   * the node once for the lot. A screen that shows a list of names is one node request, not
   * one per row.
   */
  async resolveMany(namesToResolve: readonly string[], options?: CallOptions): Promise<(Resolved | null)[]> {
    const bare = namesToResolve.map((name) => this.normalize(name))
    const api = this.needApi()
    // One deadline over the batch, not one per request. A list long enough to fill the pool
    // several times over would otherwise get `timeoutMs` again for every round.
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) => {
      const each: CallOptions = { signal }
      return this.resolveBatch(bare, api, each)
    })
  }

  private async resolveBatch(bare: string[], api: Api, options: CallOptions): Promise<(Resolved | null)[]> {
    const found = await mapLimitDistinct(
      bare,
      (name) => name,
      this.concurrency,
      (name) => api.name(name, options)
    )

    const resolved = found.map((row, at): Resolved | null => {
      if (!row) return null
      const name = bare[at]!
      if (!isOwnerType(row.ownerType))
        throw new ApiError(`the API reports an unknown owner type ${row.ownerType}`, ANSWERED)
      const owner = fromApi('owner', () => hex32(row.owner, 'owner'))
      const card = fromApi('card', () => (row.card ? cardOf(this.prefix, row.card, name) : null))
      const answer: Resolved = {
        name,
        display: names.display(name),
        address: ownerAddress(this.prefix, row.ownerType, owner) ?? null,
        ownerType: row.ownerType,
        owner: row.owner,
        deedAddress: deedAddressOf(this.registry, name, row.ownerType, owner),
        proven: null,
        card,
        records: recordsOfCard(card),
      }
      // The same owner the deed address derives from. `ownerType` 4 says the payload names a
      // covenant lineage.
      if (row.ownerType === OwnerType.CovenantId) answer.ownerCovenantId = toHex(owner)
      return answer
    })

    if (!this.node) return resolved
    const { rows } = await proveRows(
      this.nodeContext(),
      resolved.filter((r) => r !== null),
      options
    )
    let at = 0
    return resolved.map((r) => (r === null ? null : rows[at++]!))
  }

  /**
   * The address to pay for a name, or null when there is none to pay.
   *
   * Null covers both a name nobody owns and one owned by a covenant, which has no address.
   * {@link resolveName} tells the two apart.
   *
   * With a node, a name the node refutes throws {@link RefutedError}. Without a node there is
   * nothing to refute it with, so this returns the API's answer as it stands. The signature is
   * the same either way, so adding a node changes no line of a caller's code.
   */
  async addressFor(name: string, options?: CallOptions): Promise<string | null> {
    const resolved = await this.resolveName(name, options)
    if (!resolved) return null
    if (resolved.proven === false) throw new RefutedError(resolved.name, resolved.deedAddress, 'deed')
    return resolved.address
  }

  /**
   * What one label names under one name, or null when the parent resolves to nothing. Needs the
   * API.
   *
   * It splits the input, resolves the parent as {@link resolveName} does, and reads the label's key
   * off the parent's card. With a node it proves that card first. The answer carries a `payee`
   * or a `fault`, never both.
   *
   * It throws {@link SubnameError} for an input that names no subname, which includes a bare
   * name. Call {@link resolveName} for a name.
   */
  async resolveSubname(input: string, options?: CallOptions): Promise<Subname | null> {
    const { parent, label } = names.splitSubname(input)
    if (label === null) {
      throw new SubnameError(
        // The canonical form, as the message of `normalize` quotes it.
        `${JSON.stringify(names.display(parent))} is a name and carries no label. Call resolveName or addressFor for a name`,
        'no-label'
      )
    }
    const resolved = (await this.resolveMany([parent], options))[0]
    if (!resolved) return null
    const answer = (payee: string | null, fault?: string): Subname => {
      const subname: Subname = {
        kind: 'subname',
        parent: resolved,
        label,
        display: `${label}.${resolved.display}`,
        payee,
      }
      if (fault !== undefined) subname.fault = fault
      return subname
    }
    // Rule 2 settles the owner scheme before it reads any card. A covenant-held parent holds no
    // card, so a reader that starts at the card answers `no-card` and names the wrong cause.
    if (resolved.ownerType === OwnerType.CovenantId) return answer(null, 'parent-in-covenant')
    // The node's verdict comes before the API's listing. With the deed refuted, the card arms
    // below answer about the API's silence rather than about the node's refusal.
    if (resolved.proven === false) return answer(null, 'refuted')
    const card = resolved.card
    if (!card) return answer(null, 'no-card')
    // The same order inside the card, so a refuted card never reads as an unreadable one.
    if (card.proven === false) return answer(null, 'refuted')
    if (!card.records) return answer(null, 'unreadable-card')
    try {
      const payee = subnameOf(resolved.ownerType, card.records, label, this.prefix)
      return payee === null ? answer(null, 'no-such-label') : answer(payee)
    } catch (e) {
      if (e instanceof SubnameError) return answer(null, e.tag)
      throw e
    }
  }

  /**
   * The address to pay for a subname, or null when there is none to pay. Needs the API.
   *
   * Null covers a parent that resolves to nothing and an entry with no payee.
   * {@link resolveSubname} tells them apart through `fault`. The input must name a subname, so
   * this call and {@link addressFor} never answer about each other's subject.
   *
   * With a node, a parent whose deed or whose card the node refutes throws {@link RefutedError}
   * instead of an answer. Without a node there is nothing to refute it with, and this call
   * returns the API's answer as it stands.
   */
  async payeeFor(input: string, options?: CallOptions): Promise<string | null> {
    const found = await this.resolveSubname(input, options)
    if (!found) return null
    const { name, deedAddress, proven, card } = found.parent
    if (proven === false) throw new RefutedError(name, deedAddress, 'deed')
    // The card's own verdict, not the tag beside it.
    if (card?.proven === false) throw new RefutedError(name, deedAddress, 'card')
    return found.payee
  }

  /**
   * What a typed string pays, or why it pays nothing. One call for a send field. Needs the API
   * for a name or a subname, and nothing for an address.
   *
   * It runs {@link classify} and then one call for the kind: {@link resolveName} for a name,
   * {@link resolveSubname} for a subname. At most one API request, and none for an address or
   * for an input that names nothing. With a node, one probe where there is a deed to probe. It
   * never throws on the input itself: an input that names nothing is the `neither` arm, with
   * the rule's own words.
   *
   * With a node, a name whose deed the node refutes, and a subname whose parent's deed or card
   * the node refutes, throw {@link RefutedError}, as {@link addressFor} and {@link payeeFor}
   * do. Without a node there is nothing to refute with, and the answer is the API's as it stands.
   *
   * A subname's address is the parent owner's entry. A send field that pays no subname tests
   * `kind` before it reads `address`.
   */
  async recipientFor(input: string, options?: CallOptions): Promise<Recipient> {
    const typed = this.classify(input)
    switch (typed.kind) {
      case 'address':
        return typed
      case 'neither':
        return { ...typed, address: null }
      case 'name': {
        const found = await this.resolveName(typed.name, options)
        if (!found) return { ...typed, address: null, proven: null, fault: 'unresolved' }
        if (found.proven === false) throw new RefutedError(found.name, found.deedAddress, 'deed')
        if (found.address === null) return { ...typed, address: null, proven: found.proven, fault: 'in-covenant' }
        return { ...typed, address: found.address, proven: found.proven }
      }
      case 'subname': {
        const found = await this.resolveSubname(typed.display, options)
        const { label, display } = typed
        if (!found) {
          const parent = { name: typed.parent, display: names.display(typed.parent) }
          return { kind: 'subname', parent, label, display, address: null, fault: 'parent-unresolved' }
        }
        const { parent, payee, fault } = found
        if (parent.proven === false) throw new RefutedError(parent.name, parent.deedAddress, 'deed')
        // The card's own verdict, not the tag beside it.
        if (parent.card?.proven === false) throw new RefutedError(parent.name, parent.deedAddress, 'card')
        const answer: RecipientSubname = { kind: 'subname', parent, label, display, address: payee }
        if (fault !== undefined) answer.fault = fault
        return answer
      }
    }
  }

  /** The ACTIVE names an address owns, in {@link displayOrder}. Needs the API. */
  async namesOf(address: string, options?: CallOptions): Promise<OwnedName[]> {
    return (await this.namesOfMany([address], options))[0]!
  }

  /**
   * {@link namesOf} for every address. The answer holds one list for each address you passed.
   *
   * As in {@link resolveMany}, this asks the node once for every deed of every address, which
   * is what makes a page of transaction history affordable to label.
   */
  async namesOfMany(addresses: readonly string[], options?: CallOptions): Promise<OwnedName[][]> {
    const owners = addresses.map((address) => ownerOfParsed(parseAddress(address, this.prefix)))
    const api = this.needApi()
    // One deadline over the batch, as in {@link resolveMany}.
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) =>
      this.namesOfBatch(addresses, owners, api, { signal })
    )
  }

  private async namesOfBatch(
    addresses: readonly string[],
    owners: ReturnType<typeof ownerOfParsed>[],
    api: Api,
    options: CallOptions
  ): Promise<OwnedName[][]> {
    const found = await mapLimitDistinct(
      addresses,
      (a) => a,
      this.concurrency,
      (a) => api.address(a, options)
    )

    // Every answer is capped, and a page of addresses is as many answers. The derivation runs
    // in chunks that yield between them, so a cancel or the deadline stops it there, and a
    // screen keeps drawing while its page is named.
    let sinceYield = 0
    const owned: OwnedName[][] = []
    for (const [at, row] of found.entries()) {
      const { ownerType, owner } = owners[at]!
      const listed = fromApi('name list', () => {
        const sorted = [...bounded(row.names, 'names')].sort(displayOrder)
        const cards = new Map<string, CardOut>()
        for (const c of bounded(row.cards, 'cards'))
          if (c.name !== undefined && !cards.has(c.name)) cards.set(c.name, c)
        return { names: sorted, cards }
      })
      const list: OwnedName[] = []
      for (const name of listed.names) {
        if (++sinceYield > DERIVE_CHUNK) {
          sinceYield = 0
          await yieldNow(options.signal)
        }
        list.push(
          fromApi('name list', () => {
            const c = listed.cards.get(name)
            const card = c ? cardOf(this.prefix, c, name) : null
            return {
              name,
              display: names.display(name),
              deedAddress: deedAddressOf(this.registry, name, ownerType, owner),
              proven: null,
              card,
              records: recordsOfCard(card),
              primary: false,
            }
          })
        )
      }
      owned.push(list)
    }

    if (!this.node) return owned.map((list) => markPrimary(list, () => 0))
    const { rows, held } = await proveRows(this.nodeContext(), owned.flat(), options)
    let at = 0
    return owned.map((list) =>
      markPrimary(
        list.map(() => rows[at++]!),
        (a, b) => deedOrder(held.get(a.deedAddress)!, held.get(b.deedAddress)!)
      )
    )
  }

  /**
   * Every unswept card an address's key can sweep, live or retired. Needs the API.
   *
   * A wallet asks this to find the cards it left behind, from a transfer that did not sweep
   * them or an update whose old card another wallet minted. Only the node's UTXO set says
   * whether one can still be swept, so `proven` is null here. A covenant-id address has no key
   * and throws.
   */
  async cardsOf(address: string, options?: CallOptions): Promise<Card[]> {
    const { ownerType, owner } = ownerOfParsed(parseAddress(address, this.prefix))
    if (!isSpenderType(ownerType)) {
      throw new ConfigError(
        `${address} is a script address, which no signature satisfies, so no card names it as spender`
      )
    }
    const api = this.needApi()
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) => {
      const found = await api.spenderCards(ownerType, toHex(owner), { signal })
      const listed = fromApi('card list', () => bounded(found.cards, 'cards'))
      const cards: Card[] = []
      for (const [at, c] of listed.entries()) {
        if (at > 0 && at % DERIVE_CHUNK === 0) await yieldNow(signal)
        cards.push(fromApi('card list', () => cardOf(this.prefix, c)))
      }
      return cards
    })
  }

  /**
   * The one name to show for an address, or null when there is none to show.
   *
   * The registry has no notion of a primary name, and the chain privileges none of an address's
   * names. The owner says which one they mean with a card that sets `primary`. Where no card
   * does, {@link displayOrder} decides, so every integrator shows the same name.
   *
   * This decides what a reader sees, never where value goes. With a node configured, only names
   * the node holds are eligible, and only a card the node proves can claim.
   */
  async displayNameFor(address: string, options?: CallOptions): Promise<string | null> {
    return (await this.displayNamesFor([address], options))[0]!
  }

  /** {@link displayNameFor} for every address. The answer holds one slot for each address you passed. */
  async displayNamesFor(addresses: readonly string[], options?: CallOptions): Promise<(string | null)[]> {
    const owned = await this.namesOfMany(addresses, options)
    return owned.map((list) => (list.find((n) => n.primary) ?? list.find((n) => n.proven !== false))?.display ?? null)
  }

  /**
   * Which of the four states the registry holds a name in. Needs the API.
   *
   * {@link resolveName} answers the ACTIVE case and null for the rest, which is the right shape for
   * "who do I pay" and the wrong one for telling a reservation from a free name.
   */
  async lookup(name: string, options?: CallOptions): Promise<Lookup> {
    const bare = this.normalize(name)
    const key = toHex(names.keyBytesOf(bare))
    const found = await this.needApi().nameKey(bare, options)
    switch (found.kind) {
      case 'active': {
        const resolved = await this.resolveName(bare, options)
        // The key endpoint called it ACTIVE and the name endpoint named no owner. One of the
        // two is behind, so this call serves neither.
        if (!resolved) throw new ApiError('the API reports the name as active and then names no owner for it', ANSWERED)
        return { kind: 'active', name: bare, key, resolved }
      }
      case 'pending': {
        const answer: Lookup = { kind: 'pending', name: bare, key }
        if (found.deed?.deedAddress !== undefined) answer.deedAddress = found.deed.deedAddress
        if (found.deed?.acceptedDaa !== undefined) answer.acceptedDaa = found.deed.acceptedDaa
        return answer
      }
      case 'ownerUnknown':
        return { kind: 'ownerUnknown', name: bare, key }
      case 'free': {
        const answer: Lookup = { kind: 'free', name: bare, key }
        if (found.covering) answer.covering = { lo: found.covering.lo, hi: found.covering.hi }
        return answer
      }
      default:
        throw new ApiError(`the API reports an unknown kind ${String(found.kind)} for a name`, ANSWERED)
    }
  }

  /**
   * The address a PENDING deed for `name` sits at, once `address` published its claim.
   *
   * Pure: it asks nothing. A wallet derives this after broadcasting a registration, to ask its
   * own node whether the reservation landed. An owner lookup lists live registrations alone, so
   * the API cannot answer that.
   */
  pendingDeedAddress(name: string, address: string): string {
    const bare = this.normalize(name)
    const { ownerType, owner } = ownerOfParsed(parseAddress(address, this.prefix))
    const claim = names.claimOf(bare, ownerType, owner)
    return this.registry.deed.address(this.prefix, encodePendingDeedState(names.keyBytesOf(bare), claim)).text
  }

  /** The claim a registration of `name` by `address` publishes, as hex. Pure: it asks nothing. */
  claimOf(name: string, address: string): string {
    const { ownerType, owner } = ownerOfParsed(parseAddress(address, this.prefix))
    return toHex(names.claimOf(this.normalize(name), ownerType, owner))
  }

  /** Whether the node holds the PENDING deed of a registration of `name` by `address`. */
  async verifyPending(name: string, address: string, options?: CallOptions): Promise<boolean> {
    const deed = this.pendingDeedAddress(name, address)
    return (await probe(this.nodeContext(), [deed], options)).has(deed)
  }

  /** {@link available} for every name. The answer holds one slot for each name you passed. */
  async availableMany(namesToCheck: readonly string[], options?: CallOptions): Promise<boolean[]> {
    const bare = namesToCheck.map((name) => this.normalize(name))
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) =>
      mapLimitDistinct(
        bare,
        (n) => n,
        this.concurrency,
        (n) => this.available(n, { signal })
      )
    )
  }

  /**
   * Whether anybody can register a name now. Needs the API. With a node, true only once the
   * node holds the gap that covers the name's key, which is what a registration splits.
   *
   * False covers a name held, one in registration, and one whose owner the index cannot name.
   * {@link lookup} tells them apart.
   */
  async available(name: string, options?: CallOptions): Promise<boolean> {
    const bare = this.normalize(name)
    const found = await this.needApi().nameKey(bare, options)
    if (found.kind !== 'free') return false
    if (!this.node) return true
    if (!found.covering) {
      throw new ApiError(
        'the API reports the name as free but names no gap covering its key, so nothing can be proven',
        ANSWERED
      )
    }
    const covering = found.covering
    const lo = fromApi('covering gap', () => hex32(covering.lo, 'covering.lo'))
    const hi = fromApi('covering gap', () => hex32(covering.hi, 'covering.hi'))
    const key = names.keyBytesOf(bare)
    if (!lessThan(lo, key) || !lessThan(key, hi)) {
      // The API called the name free and then named a gap that does not cover its key. It
      // contradicted itself, so nothing is known.
      throw new ApiError("the API names a covering gap that does not contain the name's key", ANSWERED)
    }
    const gap = this.registry.gap.address(this.prefix, encodeGapState(lo, hi)).text
    return (await probe(this.nodeContext(), [gap], options)).has(gap)
  }

  /**
   * What happened to a name, newest first. Needs the API, and only the API. History is the one
   * question a node cannot answer, because the chain keeps no record of a spent deed.
   *
   * A page at a time. `limit` is 1 to 100 and defaults to 5. `offset` counts from the newest.
   */
  async history(name: string, page?: { limit?: number; offset?: number } & CallOptions): Promise<History> {
    const bare = this.normalize(name)
    const key = toHex(names.keyBytesOf(bare))
    const found = await this.needApi().history(key, page)
    return {
      name: bare,
      key,
      total: found.total,
      limit: found.limit,
      offset: found.offset,
      complete: found.complete,
      entries: [...bounded(found.entries, 'history entries')],
    }
  }

  /** Whether the API is the right one, and whether it is current. Needs the API. */
  async status(options?: CallOptions): Promise<Health> {
    const health = await this.needApi().health(options)
    // Null rather than zero where either end is unobserved. "not known" and "current" are
    // different answers, and only one of them makes a 404 trustworthy.
    const tip = health.tipBlueScore
    const last = health.lastBlock?.blueScore
    const behind =
      typeof tip === 'number' && typeof last === 'number' ? Math.max(0, tip - health.tipDistance - last) : null
    return {
      sameRegistry:
        typeof health.registryCovenantId === 'string' &&
        health.registryCovenantId.toLowerCase() === this.registryCovenantId &&
        health.network === this.registry.network,
      caughtUp: health.caughtUp,
      healthy: health.healthy,
      behind,
      behindSeconds: behind !== null && health.netBps > 0 ? behind / health.netBps : null,
      active: health.active,
      pending: health.pending,
      ownerUnknown: health.ownerUnknown,
      // The two fields the gate above read, copied as text whatever the API sent.
      network: typeof health.network === 'string' ? health.network : String(health.network),
      registryCovenantId:
        typeof health.registryCovenantId === 'string' ? health.registryCovenantId : String(health.registryCovenantId),
    }
  }

  /** The node and what a call proves against, or a refusal where the client has no node. */
  private nodeContext(): NodeContext {
    if (!this.node) throw new NodeError('this call needs a node. Pass one in the constructor')
    return { node: this.node, registryCovenantId: this.registryCovenantId, timeoutMs: this.timeoutMs }
  }

  private needApi(): Api {
    if (!this.api) throw new ConfigError('this call needs the API, and the client was built with `api: null`')
    return this.api
  }
}

/**
 * What an input holding a dot names: a name, a subname, or neither with the reason to show.
 *
 * {@link Dotk.classify} and {@link Dotk.normalize} both read this, so one input gets one reason.
 * Where no dot survives the stripped suffix, the input is a failed name and the name rule gives
 * the reason. Where one does survive, subname rule 1 refused it and names the failing part.
 */
function dotted(input: string): { parent: string; label: string | null } | { reason: string } {
  try {
    return names.splitSubname(input)
  } catch (e) {
    const fault = e instanceof Error ? e.message : String(e)
    const bare = names.normalize(input)
    return { reason: bare.includes('.') ? fault : (names.invalidReason(bare) ?? fault) }
  }
}
