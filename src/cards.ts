// A card is the optional output that a transfer mints beside a deed to carry the name's records.
// It sits at output 1 of the transaction that created the deed's UTXO. This file holds the
// codecs, the derivations and the reader rules, and it performs no I/O.

import { Version, encodeAddress } from './bech32.js'
import { concat, equal, fromHex, toHex, utf8 } from './bytes.js'
import { DotkError, InvalidAddressError, SubnameError } from './errors.js'
import { blake2b256, blake3 } from './hash.js'
import { validateLabel } from './names.js'
import { type OwnerBytes, checkPayload, ownerAddress } from './owner.js'
import { OwnerType, isOwnerType, isSpenderType } from './state.js'

export { isSpenderType }

/** The value that every minted card holds, in sompi. It is 0.5 KAS, reclaimed on update and on sweep. */
export const CARD_VALUE = 50_000_000

/** The most bytes that a record blob can hold (rule 4). */
export const CARD_BLOB_MAX = 16 * 1024

/**
 * How deep a record value can nest. A value carries at most this many containers, one inside
 * another, and a container is an array, a map or a tag. The decoder refuses a container that this
 * many others enclose. Every implementation of the record blob shares this value.
 */
export const RECORD_DEPTH_MAX = 8

/** The four bytes that a sweep must push, and the four bytes that a card payload opens with. */
export const CARD_MAGIC = utf8.encode('dotk')

/** The payload format version that follows the magic. */
export const CARD_PAYLOAD_VERSION = 1

/** `key ‖ records ‖ spenderType ‖ spender`: the four fields that a card commits to. */
export const CARD_STATE_LEN = 32 + 32 + 1 + 32

/** The local record key that names an address's primary name. Its value is a flag. */
export const PRIMARY_KEY = 'primary'

/**
 * The record keys that a client offers by name, verbatim from ENSIP-5. They are the global keys
 * and the reverse-DNS service keys. A card can carry any other key beside them, and a reader
 * keeps the keys that it does not know.
 */
export const RECORD_KEYS = {
  global: ['avatar', 'description', 'display', 'email', 'keywords', 'mail', 'notice', 'location', 'phone', 'url'],
  service: ['com.github', 'com.linkedin', 'com.peepeth', 'com.twitter', 'io.keybase', 'org.telegram'],
  local: [PRIMARY_KEY],
} as const

/** A card, a blob or a record set that is not what it claims to be. `message` says why. */
export class CardError extends DotkError {
  override name = 'CardError'
}

/**
 * One record. The value is text for everything that ENSIP-5 defines, and a boolean for a flag such
 * as `primary`. Any other CBOR item becomes an opaque value that holds the item's exact bytes as
 * hex. A reader keeps a value that it does not know, and a save writes it back unchanged. The
 * object form keeps an opaque value apart from text.
 */
export type RecordValue = string | boolean | { opaque: string }

/** The record set: keys to values, in whatever order the caller keeps them. */
export type Records = Record<string, RecordValue>

// ---- the record blob -----------------------------------------------------------------------

function cborHead(major: number, n: number): Uint8Array {
  const m = major << 5
  if (n <= 23) return Uint8Array.of(m | n)
  if (n <= 0xff) return Uint8Array.of(m | 24, n)
  if (n <= 0xffff) return Uint8Array.of(m | 25, n >> 8, n & 0xff)
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

// A lone surrogate is a string a program can build and no UTF-8 can carry. The encoder would
// write U+FFFD in its place, and the blob would then decode to a set other than the one given.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function cborText(s: string): Uint8Array {
  if (LONE_SURROGATE.test(s)) throw new CardError('record text holds a lone surrogate, which no record set can carry')
  const bytes = utf8.encode(s)
  return concat(cborHead(3, bytes.length), bytes)
}

/** Byte order on encoded keys, which is RFC 8949 §4.2.1's core deterministic order. */
function byteOrder(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

/**
 * The deterministic CBOR encoding of a record set, so that one set has one blob and one hash. This
 * function sorts the keys by their encoded bytes. That order differs from string order where one
 * key is a prefix of another.
 */
export function encodeRecords(records: Records): Uint8Array {
  const entries = Object.entries(records).map(([k, v]) => {
    // This reader recognizes two items: one text item in valid UTF-8, and one flag. Where an
    // opaque value holds either, the encoder writes it in that form. This package has no
    // deserializer, so the conversion happens here.
    const value = isOpaque(v) ? named(k, () => carried(v.opaque)) : v
    if (typeof value !== 'string' && typeof value !== 'boolean' && !isOpaque(value)) {
      throw new CardError(`record ${JSON.stringify(k)} is neither text, a flag nor an opaque value`)
    }
    return { key: cborText(k), name: k, value }
  })
  entries.sort((a, b) => byteOrder(a.key, b.key))
  const parts = [cborHead(5, entries.length)]
  for (const { key, name, value } of entries) {
    if (typeof value === 'string') parts.push(key, cborText(value))
    else if (typeof value === 'boolean') parts.push(key, Uint8Array.of(value ? 0xf5 : 0xf4))
    else
      parts.push(
        key,
        named(name, () => checkOpaque(value.opaque))
      )
  }
  const out = concat(...parts)
  if (out.length > CARD_BLOB_MAX) {
    throw new CardError(`the record set encodes to ${out.length} bytes, over the ${CARD_BLOB_MAX} byte cap`)
  }
  return out
}

/** An opaque fault named for the record it is about. */
function named<T>(key: string, run: () => T): T {
  try {
    return run()
  } catch (e) {
    if (e instanceof CardError) throw new CardError(`record ${JSON.stringify(key)}: ${e.message}`)
    throw e
  }
}

function isOpaque(v: unknown): v is { opaque: string } {
  return typeof v === 'object' && v !== null && typeof (v as { opaque?: unknown }).opaque === 'string'
}

/** Opaque hex to bytes. A refusal is a `CardError`, so that one taxonomy covers the record blob. */
function opaqueBytes(hex: string): Uint8Array {
  if (hex.length === 0) throw new CardError('opaque value is empty')
  try {
    return fromHex(hex)
  } catch {
    throw new CardError(`opaque value is not hex: ${hex}`)
  }
}

/**
 * An opaque value as this reader carries it. Where the value is one text item in valid UTF-8 or
 * one flag byte, this function converts it to text or to a flag. Otherwise it leaves the value as
 * it is, for {@link checkOpaque} to judge.
 */
function carried(hex: string): RecordValue {
  const bytes = opaqueBytes(hex)
  const head = bytes[0]!
  if (bytes.length === 1 && (head === 0xf4 || head === 0xf5)) return head === 0xf5
  if (head >> 5 === 3) {
    const c = new Cursor(bytes)
    try {
      const text = c.text()
      if (c.at === bytes.length) return text
    } catch {
      // Not one valid text item, so it stays opaque. The encoder refuses it below.
    }
  }
  return { opaque: hex }
}

/**
 * What the encoder carries: exactly one well-formed item within the depth cap, and not one this
 * reader recognizes itself. Such an item decodes as a text or flag record and breaks
 * `decode(encode(set)) == set`. Without either refusal a card's script commits to a malformed
 * value, and then nothing can read the blob again.
 */
function checkOpaque(hex: string): Uint8Array {
  const bytes = opaqueBytes(hex)
  const c = new Cursor(bytes)
  c.skip(0)
  if (c.at !== bytes.length) throw new CardError('opaque value is not one CBOR item')
  // A text item in valid UTF-8 and a bare flag byte never reach here, because `carried` converted
  // them. What can reach here is a text item that is not UTF-8, which no record set can carry.
  if (bytes[0]! >> 5 === 3)
    throw new CardError('opaque value holds text that is not UTF-8, which no record set can carry')
  return bytes
}

class Cursor {
  at = 0
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    const b = this.bytes[this.at]
    if (b === undefined) throw new CardError('record blob truncated')
    this.at += 1
    return b
  }

  take(n: number): Uint8Array {
    const end = this.at + n
    if (end > this.bytes.length) throw new CardError('record blob truncated')
    const s = this.bytes.subarray(this.at, end)
    this.at = end
    return s
  }

  /** A definite-length head: the major type and its argument. */
  head(): [major: number, n: number] {
    const b = this.byte()
    const major = b >> 5
    const info = b & 0x1f
    if (info <= 23) return [major, info]
    if (info === 24) return [major, this.byte()]
    if (info === 25) {
      const s = this.take(2)
      return [major, (s[0]! << 8) | s[1]!]
    }
    if (info === 26) {
      const s = this.take(4)
      return [major, ((s[0]! << 24) | (s[1]! << 16) | (s[2]! << 8) | s[3]!) >>> 0]
    }
    throw new CardError(`record blob uses an unsupported CBOR head 0x${b.toString(16).padStart(2, '0')}`)
  }

  text(): string {
    const [major, n] = this.head()
    if (major !== 3) throw new CardError('record key or value is not text')
    const bytes = this.take(n)
    try {
      return utf8.decode(bytes)
    } catch {
      throw new CardError('record text is not UTF-8')
    }
  }

  /**
   * Skip one item of any major type, by RFC 8949's own table. This reads its own head byte
   * instead of calling `head`, which names its argument a length and refuses additional
   * information 27. An integer, a tag or a double needs that. `enclosing` is how many containers
   * already enclose this item.
   */
  skip(enclosing: number): void {
    const b = this.byte()
    const major = b >> 5
    const info = b & 0x1f
    const unsupported = () =>
      new CardError(`record blob uses an unsupported CBOR head 0x${b.toString(16).padStart(2, '0')}`)
    // The argument: inline, or 1, 2, 4 or 8 bytes. Where it is a length, it must fit four bytes,
    // because no conforming encoder writes an eight-byte length under the blob cap.
    const argument = (): number => {
      if (info <= 23) return info
      if (info === 24) return this.byte()
      if (info === 25) {
        const s = this.take(2)
        return (s[0]! << 8) | s[1]!
      }
      if (info === 26) {
        const s = this.take(4)
        return ((s[0]! << 24) | (s[1]! << 16) | (s[2]! << 8) | s[3]!) >>> 0
      }
      if (info === 27 && (major === 0 || major === 1 || major === 6)) {
        this.take(8)
        return 0
      }
      throw unsupported()
    }
    const deeper = (): number => {
      if (enclosing >= RECORD_DEPTH_MAX) {
        throw new CardError(`record value nests too deep, past ${RECORD_DEPTH_MAX} containers`)
      }
      return enclosing + 1
    }
    switch (major) {
      case 0:
      case 1:
        argument()
        return
      case 2:
      case 3:
        this.take(argument())
        return
      case 4: {
        const n = argument()
        const inner = deeper()
        for (let i = 0; i < n; i++) this.skip(inner)
        return
      }
      case 5: {
        const n = argument()
        const inner = deeper()
        for (let i = 0; i < 2 * n; i++) this.skip(inner)
        return
      }
      case 6: {
        argument()
        this.skip(deeper())
        return
      }
      default:
        if (info <= 23) return
        if (info === 24) {
          // A simple value below 32 in the one-byte form is ill-formed (RFC 8949 §3.3).
          if (this.byte() < 0x20) throw unsupported()
          return
        }
        if (info === 25) {
          this.take(2)
          return
        }
        if (info === 26) {
          this.take(4)
          return
        }
        if (info === 27) {
          this.take(8)
          return
        }
        throw unsupported()
    }
  }
}

/**
 * A record set from its blob. This function reads a well-formed map of text keys, in any key
 * order. A value is text, a flag, or any other definite-length CBOR item, which the reader carries
 * as an opaque value. Nothing else decodes. The hash is what commits to the bytes, so a lenient
 * reader costs nothing. An unreadable blob is still a valid card, and its records cannot be shown.
 */
export function decodeRecords(blob: Uint8Array): Records {
  if (blob.length > CARD_BLOB_MAX) {
    throw new CardError(`record blob is ${blob.length} bytes, over the ${CARD_BLOB_MAX} byte cap`)
  }
  const c = new Cursor(blob)
  const [major, n] = c.head()
  if (major !== 5) throw new CardError('record blob is not a CBOR map')
  const records: Records = {}
  for (let i = 0; i < n; i++) {
    const key = c.text()
    // This decoder recognizes text and flags only here, directly under the map. Inside a skipped
    // item a text is bytes, and so are the flag bytes.
    let value: RecordValue
    const next = c.bytes[c.at]
    if (next === 0xf4 || next === 0xf5) {
      c.at += 1
      value = next === 0xf5
    } else if (next !== undefined && next >> 5 === 3) {
      value = c.text()
    } else {
      const start = c.at
      c.skip(0)
      value = { opaque: toHex(blob.subarray(start, c.at)) }
    }
    if (Object.prototype.hasOwnProperty.call(records, key)) {
      throw new CardError(`record key ${JSON.stringify(key)} appears twice`)
    }
    putRecord(records, key, value)
  }
  if (c.at !== blob.length) throw new CardError(`record blob carries ${blob.length - c.at} trailing bytes`)
  return records
}

/**
 * Set one record, as an own property whatever the key. A plain assignment of `__proto__` sets the
 * object's prototype instead, and a blob is anyone's bytes.
 */
export function putRecord(records: Records, key: string, value: RecordValue): void {
  Object.defineProperty(records, key, { value, enumerable: true, writable: true, configurable: true })
}

/** `blake3(blob)`: the `records` field that a blob commits to. */
export function recordsOf(blob: Uint8Array): Uint8Array {
  return blake3(blob)
}

// ---- the card ------------------------------------------------------------------------------

/** The state that a card's redeem script commits to. */
export interface CardState {
  /** `blake3(name)`, the name this card speaks for. */
  key: Uint8Array
  /** `blake3(record blob)`. */
  records: Uint8Array
  /** The key scheme that can sweep the card: {@link OwnerType.Pubkey} or one of the two ECDSA parities. */
  spenderType: number
  /** The spender's key: an x-only schnorr key, or an ECDSA key's x with its parity in the scheme. */
  spender: Uint8Array
}

function bytes32(b: Uint8Array, what: string): Uint8Array {
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new TypeError(`${what} must be 32 bytes`)
  return b
}

/** A card state. This function refuses one that no key can ever sweep. */
export function cardState(key: Uint8Array, records: Uint8Array, spenderType: number, spender: Uint8Array): CardState {
  if (!isSpenderType(spenderType)) throw new CardError(`a card's spender is a key: scheme ${spenderType} has none`)
  bytes32(spender, 'spender')
  if (spender.every((b) => b === 0)) throw new CardError("a card's spender is zero, which no key can satisfy")
  return { key: bytes32(key, 'key'), records: bytes32(records, 'records'), spenderType, spender }
}

export function encodeCardState(state: CardState): Uint8Array {
  return concat(state.key, state.records, Uint8Array.of(state.spenderType), state.spender)
}

export function decodeCardState(bytes: Uint8Array): CardState {
  if (bytes.length !== CARD_STATE_LEN) throw new CardError(`card state is ${CARD_STATE_LEN} bytes, got ${bytes.length}`)
  return cardState(bytes.slice(0, 32), bytes.slice(32, 64), bytes[64]!, bytes.slice(65))
}

const OP_DROP = 0x75
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const OP_CHECKSIGECDSA = 0xab
const OP_PUSHDATA1 = 0x4c

/** A minimal data push, for the lengths a card script carries. */
function push(data: Uint8Array): Uint8Array {
  if (data.length <= 0x4b) return concat(Uint8Array.of(data.length), data)
  if (data.length <= 0xff) return concat(Uint8Array.of(OP_PUSHDATA1, data.length), data)
  throw new CardError(`a card script pushes at most 255 bytes, not ${data.length}`)
}

/**
 * The redeem script:
 * `<key> <records> OP_DROP OP_DROP <magic> OP_EQUALVERIFY <spender> OP_CHECKSIG`,
 * with `OP_CHECKSIGECDSA` over the compressed key for an ECDSA spender.
 */
export function cardRedeemScript(state: CardState): Uint8Array {
  const spender =
    state.spenderType === OwnerType.Pubkey
      ? concat(push(state.spender), Uint8Array.of(OP_CHECKSIG))
      : concat(
          push(concat(Uint8Array.of(0x02 | (state.spenderType & 1)), state.spender)),
          Uint8Array.of(OP_CHECKSIGECDSA)
        )
  return concat(
    push(state.key),
    push(state.records),
    Uint8Array.of(OP_DROP, OP_DROP),
    push(CARD_MAGIC),
    Uint8Array.of(OP_EQUALVERIFY),
    spender
  )
}

/** The P2SH locking script that a card sits at: `OP_BLAKE2B <hash> OP_EQUAL`. */
export function cardScriptPublicKey(state: CardState): Uint8Array {
  return concat(Uint8Array.of(0xaa, 0x20), blake2b256(cardRedeemScript(state)), Uint8Array.of(0x87))
}

/** The card's own address, the anchor for rule 1. */
export function cardAddress(prefix: string, state: CardState): string {
  return encodeAddress(prefix, Version.ScriptHash, blake2b256(cardRedeemScript(state)))
}

/** The 65 zero bytes that a sweep carries until the spender signs. */
export const CARD_SIG_PLACEHOLDER = new Uint8Array(65)

/** The signature script that a sweep spends with: `<sig> <magic> <redeem>`. */
export function sweepSigScript(state: CardState, sig: Uint8Array = CARD_SIG_PLACEHOLDER): Uint8Array {
  if (sig.length !== 65) throw new CardError(`a sweep signature is 65 bytes, got ${sig.length}`)
  return concat(push(sig), push(CARD_MAGIC), push(cardRedeemScript(state)))
}

/** A card to mint. The state commits to the blob. */
export interface CardMint {
  state: CardState
  blob: Uint8Array
}

/** The payload that a minting transfer carries: `magic ‖ version ‖ state ‖ blobLen:u16 LE ‖ blob`. */
export function encodeCardPayload(mint: CardMint | null): Uint8Array {
  if (!mint) return new Uint8Array(0)
  if (mint.blob.length > CARD_BLOB_MAX) {
    throw new CardError(`record blob is ${mint.blob.length} bytes, over the ${CARD_BLOB_MAX} byte cap`)
  }
  if (!equal(mint.state.records, recordsOf(mint.blob))) throw new CardError('card state does not commit to its blob')
  return concat(
    CARD_MAGIC,
    Uint8Array.of(CARD_PAYLOAD_VERSION),
    encodeCardState(mint.state),
    Uint8Array.of(mint.blob.length & 0xff, mint.blob.length >> 8),
    mint.blob
  )
}

/**
 * The card that a payload declares. The answer is `null` for a payload that is not ours. It is a
 * {@link CardError} for one that opens with our magic and is malformed, bytes after the blob
 * included. A name holds one card, so a payload that declares a second is malformed rather than
 * half read. The card returned commits to the blob beside it (rule 3), and the blob is within the
 * cap (rule 4).
 */
export function decodeCardPayload(payload: Uint8Array): CardMint | null {
  if (payload.length < 5 || !equal(payload.subarray(0, 4), CARD_MAGIC)) return null
  if (payload[4] !== CARD_PAYLOAD_VERSION) {
    throw new CardError(`card payload version ${payload[4]} is not ${CARD_PAYLOAD_VERSION}`)
  }
  const rest = payload.subarray(5)
  if (rest.length < CARD_STATE_LEN + 2) throw new CardError('card payload truncated inside a state')
  const state = decodeCardState(rest.slice(0, CARD_STATE_LEN))
  const len = rest[CARD_STATE_LEN]! | (rest[CARD_STATE_LEN + 1]! << 8)
  if (len > CARD_BLOB_MAX) throw new CardError(`record blob is ${len} bytes, over the ${CARD_BLOB_MAX} byte cap`)
  const start = CARD_STATE_LEN + 2
  if (rest.length < start + len) throw new CardError('card payload truncated inside a blob')
  if (rest.length > start + len) {
    throw new CardError(`card payload carries ${rest.length - start - len} bytes after its card`)
  }
  const blob = rest.slice(start, start + len)
  if (!equal(state.records, recordsOf(blob))) throw new CardError('card state does not commit to the blob beside it')
  return { state, blob }
}

// ---- the reader's rules --------------------------------------------------------------------

/** What a reader established about a deed before it judges a card. Rule 5 is that finding. */
export interface DeedFinding {
  /** `blake3(name)`. */
  key: Uint8Array
  /** The transaction that created the deed's current UTXO, hex. */
  outpointTxid: string
}

/**
 * The five reader rules, over what a node answered. A reader accepts a card only where all five
 * hold:
 *
 * 1. A live UTXO sits at the address the card's own claimed state derives.
 * 2. That UTXO is output 1 of the transaction that created the deed's current UTXO.
 * 3. The blob hashes to the `records` field the card's script commits to.
 * 4. The blob is at most {@link CARD_BLOB_MAX} bytes.
 * 5. The card's deed resolves and its key is that deed's, so a card for a released or evicted
 *    name is inert.
 *
 * This function throws a {@link CardError} naming the rule that failed. The caller settles the
 * deed half of rule 5 and derives the rule 1 address with {@link cardAddress}, and this function
 * settles the key half.
 *
 * `deed` is the deed UTXO the name and its owner derive. `cardUtxo` is what the node holds at the
 * card's address. `blob` is the bytes whoever handed over the card claims it commits to. The
 * outpoint index in rule 2 is what gives one name one live card.
 */
export function verifyCard(
  deed: DeedFinding,
  card: CardState,
  cardUtxo: { transactionId: string; index: number } | undefined,
  blob: Uint8Array
): void {
  if (!equal(card.key, deed.key)) throw new CardError('rule 5: the card is for another name')
  if (!cardUtxo) throw new CardError("rule 1: no live UTXO at the card's address")
  if (cardUtxo.transactionId.toLowerCase() !== deed.outpointTxid.toLowerCase() || cardUtxo.index !== 1) {
    throw new CardError("rule 2: the card is not output 1 of the transaction that created the deed's current UTXO")
  }
  if (blob.length > CARD_BLOB_MAX)
    throw new CardError(`rule 4: the blob is ${blob.length} bytes, over the ${CARD_BLOB_MAX} byte cap`)
  if (!equal(recordsOf(blob), card.records)) throw new CardError('rule 3: the blob is not the one the card commits to')
}

// ---- subnames ------------------------------------------------------------------------------

// The three subname rules. Every derivation below is one of them:
//
//   1. Split a typed input into a parent and a label, which `names.splitSubname` does.
//   2. Resolve the parent and prove its card by the five reader rules above.
//   3. Read the label's value off that card, which names an owner scheme and a 32-byte payload.
//
// A subname is a claim by the parent's owner. A node proves rule 2, and nothing proves rule 3.

/** The record key prefix a subname's label sits behind. The three subname rules run through it. */
export const SUBNAME_PREFIX = 'sub:'

/** The bytes a subname value holds: the two-byte CBOR head, the scheme byte and the payload. */
const SUBNAME_VALUE_LEN = 2 + 1 + 32

/**
 * The record key a label is stored under. The label rule runs here, so no writer can pay for an
 * entry that no lookup reaches. It throws {@link SubnameError} tagged `bad-label`.
 */
export function subnameKey(label: string): string {
  validateLabel(label)
  return SUBNAME_PREFIX + label
}

/**
 * The value a subname holds, and the one place that writes those bytes. It is one CBOR byte
 * string of 33 bytes. Those are the scheme byte and the payload, exactly as a deed stores its
 * owner.
 *
 * It carries no network prefix and no checksum. A reader renders the pair with the registry's own
 * prefix, so no card can name a payee on the wrong network. A covenant id is refused, because no
 * reader can pay one.
 */
export function subnameValue(ownerType: number, owner: Uint8Array): RecordValue {
  if (!isOwnerType(ownerType)) throw badScheme()
  if (ownerType === OwnerType.CovenantId) throw heldByCovenant()
  checkPayload(ownerType, owner)
  return { opaque: toHex(concat(Uint8Array.of(0x58, 0x21, ownerType), owner)) }
}

/**
 * The owner pair one stored entry names, or why it names none. The label rule applies to the key,
 * and subname rule 3 to the value.
 *
 * It renders nothing, so a writer can list an entry's verdict without a network prefix. The
 * `0x04` arm runs before the payload tests, so a covenant id over a zero payload reads as the
 * covenant id it is.
 */
export function subnamePair(key: string, value: RecordValue): OwnerBytes {
  // A key without the prefix is a bug in the caller, because `subnames` and `subnameOf` hand this
  // function nothing else. The message names the prefix, so the fault cannot read as a verdict on
  // a label that the key never carried.
  if (!key.startsWith(SUBNAME_PREFIX)) {
    throw new SubnameError(`${JSON.stringify(key)} carries no ${SUBNAME_PREFIX} prefix`, 'bad-label')
  }
  validateLabel(key.slice(SUBNAME_PREFIX.length))
  if (!isOpaque(value)) throw notBytes()
  let bytes: Uint8Array
  try {
    bytes = fromHex(value.opaque)
  } catch {
    // Hex this reader cannot read is no byte string, which is the arm a later kind also lands in.
    throw notBytes()
  }
  const head = bytes[0]
  if (head === undefined || head >> 5 !== 2) throw notBytes()
  // One item shape and no other: the two head bytes, then the pair. `subnameValue` writes exactly
  // this, so every implementation agrees on one byte comparison. A byte string of the same length
  // under a wider head is another shape.
  if (bytes.length !== SUBNAME_VALUE_LEN || bytes[0] !== 0x58 || bytes[1] !== 0x21) throw badLength()
  const scheme = bytes[2]!
  if (!isOwnerType(scheme)) throw badScheme()
  if (scheme === OwnerType.CovenantId) throw heldByCovenant()
  const owner = bytes.slice(3)
  checkPayload(scheme, owner)
  return { ownerType: scheme, owner }
}

/**
 * Subname rules 2 and 3: the payee one label names on a card, or null where the card holds no
 * such label.
 *
 * Callers hand this the records of a card a node proved, where there is a node, and that deed's
 * own owner scheme. A covenant holds no claim, so a parent held by one names nothing whatever card sits
 * beside it.
 */
export function subnameOf(ownerType: number, records: Records, label: string, prefix: string): string | null {
  if (ownerType === OwnerType.CovenantId) throw parentInCovenant()
  const key = subnameKey(label)
  if (!Object.prototype.hasOwnProperty.call(records, key)) return null
  const { ownerType: scheme, owner } = subnamePair(key, records[key]!)
  return payeeAddress(prefix, scheme, owner)
}

/**
 * The address of a pair {@link subnamePair} passed. That function refuses the one scheme with no
 * address, so the refusals below are unreachable today and no test reaches them. They are there
 * for a scheme added to {@link OwnerType} without an address arm. Refuse such a scheme in
 * `subnamePair` too, and until that happens these keep the fault to one row.
 */
function payeeAddress(prefix: string, ownerType: number, owner: Uint8Array): string {
  try {
    const address = ownerAddress(prefix, ownerType, owner)
    if (address !== undefined) return address
  } catch (e) {
    // Only the refusal this function is about. A `TypeError` from the encoder is a bug here,
    // and reading it as a scheme this registry does not name buries it.
    if (!(e instanceof InvalidAddressError)) throw e
  }
  throw badScheme()
}

/** One row of a card's subname listing: the label, and the payee it names or the fault that refused it. */
export interface SubnameEntry {
  label: string
  address: string | null
  fault?: string | undefined
}

/**
 * Every `sub:` entry a card carries, with its stored label and its verdict, in key-byte order.
 * Every editor and every signing surface draws its listing from here.
 *
 * A refused entry is listed too, because a writer that cannot see one destroys it or signs it
 * unseen. A stored label the rule refuses is listed as it is stored, so the row a reader removes
 * is the row the card holds.
 */
export function subnames(ownerType: number, records: Records, prefix: string): SubnameEntry[] {
  const keys = Object.keys(records).filter((key) => key.startsWith(SUBNAME_PREFIX))
  // A blob decodes in the order the card wrote, which puts the shortest key first, so this sorts
  // what it lists into key order.
  keys.sort((a, b) => byteOrder(utf8.encode(a), utf8.encode(b)))
  return keys.map((key) => {
    const label = key.slice(SUBNAME_PREFIX.length)
    if (ownerType === OwnerType.CovenantId) return { label, address: null, fault: parentInCovenant().tag }
    try {
      const { ownerType: scheme, owner } = subnamePair(key, records[key]!)
      return { label, address: payeeAddress(prefix, scheme, owner) }
    } catch (e) {
      if (e instanceof SubnameError) return { label, address: null, fault: e.tag }
      throw e
    }
  })
}

function parentInCovenant(): SubnameError {
  return new SubnameError('a covenant holds the parent, so the parent claims nothing', 'parent-in-covenant')
}

function notBytes(): SubnameError {
  return new SubnameError('the value is not a byte string', 'not-bytes')
}

function badLength(): SubnameError {
  return new SubnameError('the value is a byte string that is not 33 bytes', 'bad-length')
}

function badScheme(): SubnameError {
  return new SubnameError('the value names no owner scheme', 'bad-scheme')
}

function heldByCovenant(): SubnameError {
  return new SubnameError('a covenant id owns this entry, and no reader can pay one', 'held-by-covenant')
}
