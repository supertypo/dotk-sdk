// The node-proving layer. What the node holds at the deed and the card addresses, and the
// verdict on each card by the five reader rules. Nothing here belongs to the client: every
// function takes what it reads, so the layer is one thing to test on its own.

import type { CallOptions, CardOut } from './api.js'
import type { Card, OwnedName } from './answers.js'
import { equal, fromHex, hex32, toHex } from './bytes.js'
import {
  CARD_BLOB_MAX,
  CardError,
  PRIMARY_KEY,
  type CardState,
  type Records,
  cardAddress,
  cardState,
  decodeRecords,
  isSpenderType,
  putRecord,
  recordsOf,
  verifyCard,
} from './cards.js'
import { DERIVE_CHUNK, withDeadline, yieldNow } from './deadline.js'
import { NodeError } from './errors.js'
import type { Registry } from './manifest.js'
import * as names from './names.js'
import { type Node, type Utxo, attribute, probe as probeNode, scan as scanNode } from './node.js'
import { ownerAddress } from './owner.js'
import { encodeActiveDeedState } from './state.js'

/** What a node call needs of the client: the node, the registry it proves against, and the deadline. */
export interface NodeContext {
  readonly node: Node
  readonly registryCovenantId: string
  readonly timeoutMs: number | null
}

/** A row the node can judge: a name, where its deed sits, and the card the API listed for it. */
export interface Provable {
  name: string
  deedAddress: string
  card: Card | null
  proven: boolean | null
  records: Records
}

export function deedAddressOf(registry: Registry, name: string, ownerType: number, owner: Uint8Array): string {
  const state = encodeActiveDeedState(names.keyBytesOf(name), ownerType, owner, names.paddedName(name))
  return registry.deed.address(registry.prefix, state).text
}

/**
 * A card as the API listed it, with everything derivable derived here. That means the
 * address from the state, the spender's address from its record, and the records from the
 * blob. `name`, when the caller gives it, is the name the API listed the card under. This
 * method refuses a card for another key.
 */
export function cardOf(prefix: string, out: CardOut, name?: string): Card {
  const key = hex32(out.key, 'card key')
  if (name !== undefined && !equal(key, names.keyBytesOf(name))) {
    throw new TypeError(`a card listed under ${name} is for another key`)
  }
  if (!isSpenderType(out.spenderType)) throw new TypeError(`card spender scheme ${out.spenderType} is not a key`)
  // Rule 4's bound, applied before the decode rather than inside it. The blob is the one
  // field of a card whose size the API chooses, and it is hex, so it costs twice its bytes.
  if (out.blob.length > 2 * CARD_BLOB_MAX)
    throw new TypeError(`card blob is ${out.blob.length / 2} bytes, past the ${CARD_BLOB_MAX} a card can carry`)
  const blob = fromHex(out.blob, 'card blob')
  // Rule 3 by construction: the hash comes from the blob and not from the listing beside it.
  // The card's address hashes from this state, so adopting the API's `recordsHash` would let
  // the API point a reader at an address of its choosing. Hashing the blob instead means a
  // listing that disagrees with itself derives an address that holds nothing, and rule 1
  // catches it.
  const state = cardState(key, recordsOf(blob), out.spenderType, hex32(out.spender, 'card spender'))
  if (!Number.isInteger(out.outpointIndex) || out.outpointIndex < 0)
    throw new TypeError(`card outpoint index ${out.outpointIndex} is not an output index`)
  // The one number copied off the listing. A card holds CARD_VALUE, which no covenant pins, so
  // the value is read as a figure and never trusted as one.
  const value: unknown = out.value
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new TypeError(`card value ${String(value)} is not an amount`)
  let records: Records | null
  try {
    records = decodeRecords(blob)
  } catch {
    records = null
  }
  const card: Card = {
    key: toHex(key),
    address: cardAddress(prefix, state),
    outpointTxid: toHex(hex32(out.outpointTxid, 'card outpoint')),
    outpointIndex: out.outpointIndex,
    value: out.value,
    spenderType: out.spenderType,
    spender: toHex(state.spender),
    spenderAddress: ownerAddress(prefix, out.spenderType, state.spender)!,
    recordsHash: toHex(state.records),
    blob: out.blob.toLowerCase(),
    records,
    live: out.live,
    proven: null,
  }
  // The name matched against the key above wins. The served one is the API's word, and a card
  // filed under this key must not also carry an unchecked name.
  if (name !== undefined) card.name = name
  else if (
    out.name !== undefined &&
    names.invalidReason(out.name) === undefined &&
    equal(key, names.keyBytesOf(out.name))
  )
    card.name = out.name
  return card
}

/**
 * Judge each name's card by the five rules against the node. The caller passes what the node
 * holds at the deed addresses. One request covers every card address of the lot.
 */
function judgeCards<N extends Provable>(
  rows: N[],
  held: Map<string, Utxo>,
  at: Map<string, Utxo[]>,
  judged: Map<N, Card | null>
): void {
  for (const row of rows) {
    const card = row.card
    if (!card) {
      judged.set(row, null)
      continue
    }
    const deed = held.get(row.deedAddress)
    // Rule 5: a card whose deed the node does not hold is inert, whatever else is true of it.
    if (!deed) {
      judged.set(row, { ...card, proven: false, refusal: 'rule 5: the node does not hold the deed the card is for' })
      continue
    }
    // Rule 2 names the live card: output 1 of the deed's own transaction. That UTXO is the one
    // proven on, whatever outpoint the API listed. Any other UTXO at the address is refused by
    // rule 2, and an empty address by rule 1. Both sides are lowercase, as rule 2 compares them.
    const candidates = at.get(card.address) ?? []
    const blind = candidates.some((u) => u.transactionId === undefined || u.index === undefined)
    if (deed.transactionId === undefined || blind) {
      throw new NodeError(
        'the node client reports no outpoint on its UTXOs, so a card cannot be proven through it. ' +
          'Use one of the bundled adapters, or report `transactionId` and `index`'
      )
    }
    const deedTxid = deed.transactionId.toLowerCase()
    const utxo = candidates.find((u) => u.transactionId!.toLowerCase() === deedTxid && u.index === 1) ?? candidates[0]
    const state: CardState = {
      key: names.keyBytesOf(row.name),
      records: fromHex(card.recordsHash),
      spenderType: card.spenderType,
      spender: fromHex(card.spender),
    }
    try {
      verifyCard(
        { key: state.key, outpointTxid: deed.transactionId },
        state,
        utxo && { transactionId: utxo.transactionId!, index: utxo.index! },
        fromHex(card.blob)
      )
      // The outpoint the node holds the card at, which is the fact, where the listing's may be a
      // lagging index's. Read through the same check the listing's outpoint gets.
      judged.set(row, {
        ...card,
        outpointTxid: toHex(hex32(utxo!.transactionId!, 'card outpoint')),
        outpointIndex: utxo!.index!,
        proven: true,
      })
    } catch (e) {
      // The rule's own words. Anything else is no verdict of the five rules, and is named as such.
      const refusal = e instanceof CardError ? e.message : 'the card could not be judged'
      judged.set(row, { ...card, proven: false, refusal })
    }
  }
}

export function probe(ctx: NodeContext, addresses: string[], options?: CallOptions): Promise<Map<string, Utxo>> {
  const { node } = ctx
  if (addresses.length === 0) return Promise.resolve(new Map<string, Utxo>())
  return withDeadline('node', ctx.timeoutMs, options?.signal, (signal) =>
    probeNode(node, addresses, ctx.registryCovenantId, signal)
  )
}

function scan(ctx: NodeContext, addresses: string[], options?: CallOptions): Promise<Map<string, Utxo[]>> {
  const { node } = ctx
  return withDeadline('node', ctx.timeoutMs, options?.signal, (signal) => scanNode(node, addresses, signal))
}

/**
 * The registry's UTXOs at the deed addresses, and everything at the card addresses, in one
 * request.
 *
 * Both sets are known before either is asked for, so two requests in sequence would cost a
 * round trip and buy nothing.
 */
async function holdings(
  ctx: NodeContext,
  deedAddresses: string[],
  cardAddresses: string[],
  options?: CallOptions
): Promise<{ held: Map<string, Utxo>; at: Map<string, Utxo[]> }> {
  if (deedAddresses.length === 0 && cardAddresses.length === 0) return { held: new Map(), at: new Map() }
  const at = await scan(ctx, [...deedAddresses, ...cardAddresses], options)
  return { held: attribute(at, deedAddresses, ctx.registryCovenantId), at }
}

/**
 * Prove a batch of rows against the node in one request: the deed addresses held, and each card
 * judged by the five rules. The rows come back in the order given, with `proven`, `card` and
 * `records` settled. `held` comes back too, for a caller that orders claimants by their deeds.
 */
export async function proveRows<N extends Provable>(
  ctx: NodeContext,
  rows: N[],
  options?: CallOptions
): Promise<{ rows: N[]; held: Map<string, Utxo> }> {
  const { held, at } = await holdings(
    ctx,
    rows.map((r) => r.deedAddress),
    rows.flatMap((r) => (r.card ? [r.card.address] : [])),
    options
  )
  // In chunks that yield, as the derivation before it, so a cancel takes effect between them.
  const judged = new Map<N, Card | null>()
  for (let from = 0; from < rows.length; from += DERIVE_CHUNK) {
    if (from > 0) await yieldNow(options?.signal)
    judgeCards(rows.slice(from, from + DERIVE_CHUNK), held, at, judged)
  }
  const proven = rows.map((r): N => {
    const card = judged.get(r)!
    return { ...r, proven: held.has(r.deedAddress), card, records: recordsOfCard(card) }
  })
  return { rows: proven, held }
}

/** A name's records, taken from its card. Empty when the node refuted the card, or when its blob is not a record map. */
export function recordsOfCard(card: Card | null): Records {
  const records: Records = {}
  if (!card || card.proven === false || !card.records) return records
  for (const [key, value] of Object.entries(card.records)) putRecord(records, key, value)
  return records
}

/**
 * The node's order on two deeds that compete for `primary`. The higher DAA score comes first,
 * and the lower outpoint breaks a tie, so the most recent statement stands.
 */
export function deedOrder(a: Utxo, b: Utxo): number {
  const daa = (b.daaScore ?? 0) - (a.daaScore ?? 0)
  if (daa !== 0) return daa
  const txid = (a.transactionId ?? '').localeCompare(b.transactionId ?? '')
  return txid !== 0 ? txid : (a.index ?? 0) - (b.index ?? 0)
}

/** Mark the one name of a list that is the address's primary, by the claimants' order. */
export function markPrimary(list: OwnedName[], order: (a: OwnedName, b: OwnedName) => number): OwnedName[] {
  const claimants = list.filter((n) => n.proven !== false && n.records[PRIMARY_KEY] === true)
  const winner = claimants.sort(order)[0]
  return list.map((n) => ({ ...n, primary: n === winner }))
}
