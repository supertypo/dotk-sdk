// The answers this package gives: every type a call on `Dotk` returns or takes. `dotk.ts`
// re-exports them, so a consumer imports from the package and never from here.

import type { HistoryEntry } from './api.js'
import type { Records } from './cards.js'
import type { Manifest } from './manifest.js'
import type { Node } from './node.js'
import type { Owner } from './owner.js'

export interface DotkOptions {
  /**
   * The Kaspa network id (`mainnet`, `testnet-10`, `simnet`, ...). It chooses among the
   * registries this package carries a manifest for. Naming one it does not carry throws, because
   * every address derived under it belongs to a registry that is not there. Defaults to mainnet
   * where that is bundled, and otherwise to the single registry that is. See
   * `DEPLOYMENT_NETWORKS`.
   */
  network?: string | undefined
  /**
   * The registry API's base, without a version segment. `Api` appends its own, so one
   * setting survives a version bump. Defaults to the directory for the registry this client
   * resolved to (`DIRECTORIES` in `deployments.ts`). Setting it to `null` runs without one.
   */
  api?: string | null | undefined
  /** A Kaspa node (see `fromWasm`, `fromWrpcJson`, `fromGrpc`). Without one this package proves nothing. */
  node?: Node | undefined
  /** A deployment's manifest this build does not carry, instead of one it does. */
  genesis?: Manifest | undefined
  /** The `fetch` to reach the API with. Defaults to the global one. */
  fetch?: typeof fetch | undefined
  /**
   * How long any one call can take, in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`.
   * Setting it to `null` waits for ever. A caller's own `signal` still ends a call sooner.
   */
  timeoutMs?: number | null | undefined
  /** API requests in flight at once in a batch call. Defaults to `DEFAULT_CONCURRENCY`. */
  concurrency?: number | undefined
}

/** What a name resolves to. */
export interface Resolved extends Owner {
  /** The bare on-chain name. */
  name: string
  /** The name as readers show it: the bare name with `.k`. */
  display: string
  /** The owner's address, or null when the owner is a covenant (see `ownerCovenantId`). */
  address: string | null
  /** The covenant that owns the name, when one does. */
  ownerCovenantId?: string | undefined
  /** The deed's own address: the UTXO that proves the ownership. */
  deedAddress: string
  /** Whether the node holds the deed, or null when the caller gave no node. */
  proven: boolean | null
  /** The name's card, as the API lists it and the node judges it, or null. */
  card: Card | null
  /** The name's records, which are its card's unless the node refutes the card. Empty when there is no card. */
  records: Records
}

/** One card: a name's records, and who can reclaim the output that carries them. */
export interface Card {
  /** The bare name the card speaks for. Absent on a spender listing where the index has no row for the key. */
  name?: string | undefined
  /** `blake3(name)`, hex. This is the key the card commits to, and a spender listing has it even where the name is gone. */
  key: string
  /** The card's own address, which is where its UTXO sits. It derives from the card's state. */
  address: string
  /** The minting transaction and the card's output index in it. */
  outpointTxid: string
  outpointIndex: number
  /** In sompi. */
  value: number
  /** The key that can sweep the card, as a scheme byte and payload, and its address. */
  spenderType: number
  spender: string
  spenderAddress: string
  /** `blake3(blob)`, hex. */
  recordsHash: string
  /** The record blob, hex. */
  blob: string
  /**
   * The records the blob decodes to, with an unrecognized value kept as an opaque value. Null
   * when the blob is not a record map.
   */
  records: Records | null
  /**
   * Whether the index calls the card current. A current card is output 1 of the transaction
   * that created the deed's current UTXO, and it is unswept. A retired card is a leftover
   * that its spender can sweep.
   */
  live: boolean
  /**
   * Whether the node proves the card by the five reader rules, or null when the caller gave no
   * node. This package leaves a card the node refutes out of the name's `records`.
   */
  proven: boolean | null
  /** Which of the five rules refuted the card, in the rule's own words. Present only where `proven` is false. */
  refusal?: string | undefined
}

/**
 * What the registry holds for a name, which is never a bare "taken".
 *
 * `resolveName` answers `active` and null for the rest, because the API serves a name lookup for an
 * ACTIVE registration alone. `pending` is a reservation nobody can pay yet, `ownerUnknown` a deed
 * whose owner the index cannot name, and `free` a key no deed sits on. A send field that cannot
 * tell `pending` from `free` either invites a payment into a registration that did not complete,
 * or reports a held name as free.
 */
export type Lookup =
  | { kind: 'active'; name: string; key: string; resolved: Resolved }
  | { kind: 'pending'; name: string; key: string; deedAddress?: string | undefined; acceptedDaa?: number | undefined }
  | { kind: 'ownerUnknown'; name: string; key: string }
  | { kind: 'free'; name: string; key: string; covering?: { lo: string; hi: string } | undefined }

/** A page of what happened to one name, newest first. */
export interface History {
  /** The bare on-chain name this is the history of. */
  name: string
  /** The key it hashes to, which is what the registry records history against. */
  key: string
  /** How many entries exist in all, so a caller can page without probing for the end. */
  total: number
  limit: number
  offset: number
  /**
   * Whether the oldest entry held is the name's own registration. `false` means the record
   * starts mid-story, because an index can be younger than the registry and Kaspa prunes the
   * blocks that hold an older past.
   */
  complete: boolean
  entries: HistoryEntry[]
}

/** One of an address's names. */
export interface OwnedName {
  name: string
  display: string
  deedAddress: string
  proven: boolean | null
  card: Card | null
  /** As on {@link Resolved}. */
  records: Records
  /**
   * Whether this is the address's primary name. At most one name in a list carries it. A card
   * that sets `primary` claims it, and among claimants the node's order decides. Without a node
   * the first claimant in `displayOrder` wins.
   */
  primary: boolean
}

/** What a registration costs, in sompi. Every figure comes from the bundled deployment. */
export interface Quote {
  /** The bare on-chain name these figures are for. */
  name: string
  /** The registration fee, set by the name's byte length and paid to the devfund. */
  fee: number
  /** Locked in the deed for as long as the owner holds the name, and returned when the owner releases it. */
  bond: number
  /** Held between the two registration transactions and returned by the second. */
  deposit: number
  /** A registration splits one gap into two, so it funds one more of them. */
  gapValue: number
  /**
   * The bond and the gap value together. A registration parks this inside the name for as long
   * as it lives, and gets it back when it ends.
   *
   * One quantity because nothing separates the halves: `split` posts them together, `release`
   * refunds them together, and `evict` forfeits them together. The deposit is not in it, because
   * that comes back at `activate`.
   */
  lockedValue: number
  /**
   * What the registration must find in the wallet, with network fees left out.
   *
   * The deposit comes back on the same pass. What has to be on hand is therefore the larger of
   * the deposit and the fee, and not their sum.
   */
  totalToFund: number
}

/**
 * What one label names under one name. A subname is a claim by the parent's owner, and the chain
 * proves none of it.
 *
 * `payee` is the address the parent's card names for the label, and null wherever the entry pays
 * nobody. `fault` then says why. No field here carries the parent's own address or its proof,
 * because a page must never put the node's mark on a payee. Read those through `parent`.
 */
export interface Subname {
  kind: 'subname'
  /** The parent name's own answer, the one `Dotk.resolveName` gives for that name. */
  parent: Resolved
  /** The label, as it is stored: `bob`, or `dev.team`. */
  label: string
  /** The full form readers show: `bob.alice.k`. */
  display: string
  /** Where the parent's owner says to pay, or null. */
  payee: string | null
  /**
   * Why there is no payee, when there is none. Absent where there is one. The tags are a frozen
   * vocabulary, so a caller can branch on one.
   *
   * `parent-in-covenant` comes from the parent deed's own owner scheme, before any entry is
   * read. `not-bytes`, `bad-length`, `bad-scheme`, `held-by-covenant`, `zero-payload` and
   * `not-a-point` come from the stored entry. `no-card` is a parent with no
   * card, `unreadable-card` a blob that is not a record set, `no-such-label` a card holding no
   * such key, and `refuted` a node that refutes the parent's card or its deed. `parent.proven`
   * tells those last two apart.
   *
   * `Dotk.resolveSubname` throws `no-suffix`, `bad-parent`, `bad-label` and `no-label` off
   * the typed input instead of riding them here.
   */
  fault?: string | undefined
}

/** A typed name: the bare on-chain spelling, and the form readers show. */
export type ClassifiedName = { kind: 'name'; name: string; display: string }
/** A typed subname: the bare parent, the label as stored, and the full form `bob.alice.k`. */
export type ClassifiedSubname = { kind: 'subname'; parent: string; label: string; display: string }
/** A typed address of this network, in its canonical spelling. */
export type ClassifiedAddress = { kind: 'address'; address: string }
/** Neither, with the rule's own words for why. */
export type ClassifiedNeither = { kind: 'neither'; reason: string }

/**
 * What a string a person typed can be. Never throws. See `Dotk.classify`. The arms are
 * type aliases rather than interfaces, so an answer still passes where a `Record<string,
 * unknown>` is accepted.
 */
export type Classified = ClassifiedName | ClassifiedSubname | ClassifiedAddress | ClassifiedNeither

/** A typed address, which pays itself. */
export type RecipientAddress = ClassifiedAddress

/** A name, with what it pays. */
export type RecipientName = ClassifiedName & {
  /** The address to pay, or null when there is none. `proven` says whether a node checked it. */
  address: string | null
  /**
   * The node's word on the deed. Null without a node, and null where there is no deed to probe,
   * which is the `unresolved` arm. Never `false`: where a node refutes the deed,
   * `Dotk.recipientFor` throws `RefutedError` instead of answering.
   */
  proven: boolean | null
  /**
   * Why there is no address, when there is none. `unresolved` is a name the API serves no ACTIVE
   * registration for: free, still registering, or an owner the index cannot name, which
   * `Dotk.lookup` tells apart, or an API behind the chain, which `Dotk.status`
   * shows as `caughtUp: false`. `in-covenant` is a name a covenant holds, which has no address
   * to pay; `Dotk.resolveName` names the covenant. A tag from a newer version arrives as
   * itself.
   */
  fault?: string | undefined
}

/**
 * A subname, with what it pays. The address is the parent owner's entry. The chain proves the
 * parent and the card, never the entry, so a page shows the address as that owner's entry and
 * puts a proof mark on the parent line alone.
 */
export type RecipientSubname = {
  kind: 'subname'
  /**
   * The parent name's own answer, the one `Dotk.resolveName` gives for that name. Its
   * `proven` is the parent's, so a proof mark belongs beside `parent.display` and never beside
   * `address`.
   */
  parent: Resolved
  /** The label, as it is stored: `bob`, or `dev.team`. */
  label: string
  /** The full form readers show: `bob.alice.k`. */
  display: string
  /**
   * The address the parent's owner set under the label, or null when the entry pays nobody.
   * Nothing on the chain proves it. It is {@link Subname.payee} under the name a send field
   * pays from.
   */
  address: string | null
  /**
   * Why there is no address, when there is none: a {@link Subname.fault} tag. `refuted` never
   * rides here, because `Dotk.recipientFor` throws `RefutedError` instead.
   */
  fault?: string | undefined
}

/**
 * A subname whose parent the API serves no ACTIVE registration for, so there is no parent answer
 * and no card to read. `parent` keeps the parent's name and display form, so a page can still
 * say which name is unresolved.
 */
export type RecipientSubnameUnresolved = {
  kind: 'subname'
  parent: { name: string; display: string }
  label: string
  display: string
  address: null
  fault: 'parent-unresolved'
}

/** Neither a name, a subname nor an address, so nothing to pay, with the rule's own words. */
export type RecipientNeither = ClassifiedNeither & { address: null }

/**
 * What a typed string pays, or why it pays nothing. See `Dotk.recipientFor`. Every arm
 * carries `address`, so a send field reads that one field and branches on `kind` to say what it
 * is paying. It is not a {@link Classified}: on the subname arms `parent` is the parent's own
 * answer rather than its bare name.
 */
export type Recipient =
  RecipientAddress | RecipientName | RecipientSubname | RecipientSubnameUnresolved | RecipientNeither

/**
 * What an API says about itself, named for the endpoint it comes from. `status` in this registry
 * is a deed's on-chain lifecycle byte and means nothing else.
 */
export interface Health {
  /** Whether the API serves the registry this client was built for. Read this first. */
  sameRegistry: boolean
  /**
   * Whether the API is level with the chain right now. Level means its last block is under 10 s
   * old and under a minute of blocks behind the tip. The API does not latch this, so one that
   * stalls says `false` again. A lagging API answers 404 for names beyond the point it reached,
   * which looks the same as a name nobody owns. `behind` is the distance itself.
   */
  caughtUp: boolean
  /** The API's own verdict, which also covers its last self-test. */
  healthy: boolean
  /**
   * How far behind the chain the API is, in blue score, or null before it observed both ends.
   * This figure subtracts the API's own tip distance, because that much is deliberate rather
   * than late.
   */
  behind: number | null
  /** `behind` as seconds, at the network's nominal block rate. */
  behindSeconds: number | null
  /** Live ACTIVE names, the ones still in registration, and the ones whose owner the index cannot name. */
  active: number
  pending: number
  ownerUnknown: number
  /** What the API serves, for the message when `sameRegistry` is false. */
  network: string
  registryCovenantId: string
}
