// The state regions the covenants keep, encoded as the compiler's field prolog encodes them.
// There is one explicit data push per field, so a 1-byte field is `01 xx` and a 32-byte field
// `20 …`.

import { concat } from './bytes.js'

export const STATUS_ACTIVE = 0x02
export const STATUS_PENDING = 0x01
export const DEED_STATE_LEN = 103
export const GAP_STATE_LEN = 66

/** The KCC-2 owner schemes a deed can carry, by scheme byte. */
export const OwnerType = {
  /** A 32-byte x-only schnorr public key. The address is its `kaspa:q…` form. */
  Pubkey: 0x00,
  /** A P2SH script-hash. The address is its `kaspa:p…` form. */
  ScriptHash: 0x03,
  /** A KIP-20 covenant id. Another covenant owns the deed, and the deed has no address. */
  CovenantId: 0x04,
  /**
   * An ECDSA key with odd y, stored as its x. The address carries the SEC1 `0x03` prefix. The
   * two p2pk-ecdsa bytes are the `0x05`/`0x06` proposed to KCC-2 in kaspanet/kccs#23, with bit 7
   * set. Bit 7 marks the half KCC-2 keeps for a convention's own schemes. The low bit is the
   * y-parity.
   */
  P2pkEcdsaOdd: 0x85,
  /** An ECDSA key with even y, stored as its x. The address carries the SEC1 `0x02` prefix. */
  P2pkEcdsaEven: 0x86,
} as const

export type OwnerTypeByte = (typeof OwnerType)[keyof typeof OwnerType]

export function isOwnerType(b: number): b is OwnerTypeByte {
  return Object.values(OwnerType).includes(b as OwnerTypeByte)
}

/**
 * Whether approval under a scheme needs a transaction signature. Such a scheme's payload is a
 * public key, and that is the one payload a client can test against the curve. A script hash and
 * a covenant id commit to a preimage nobody here can know.
 *
 * This list is the only one. A scheme named nowhere here takes no curve test, so name a new
 * scheme here in the same change that adds it to {@link OwnerType}.
 */
export function isSpenderType(ownerType: number): boolean {
  return ownerType === OwnerType.Pubkey || ownerType === OwnerType.P2pkEcdsaEven || ownerType === OwnerType.P2pkEcdsaOdd
}

function pushByte(b: number): Uint8Array {
  return new Uint8Array([0x01, b])
}

function push32(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new TypeError(`expected 32 bytes, got ${bytes.length}`)
  return concat(new Uint8Array([0x20]), bytes)
}

/** An ACTIVE deed's state: status, key, owner scheme, owner payload, padded name. */
export function encodeActiveDeedState(
  key: Uint8Array,
  ownerType: number,
  owner: Uint8Array,
  name: Uint8Array
): Uint8Array {
  return concat(pushByte(STATUS_ACTIVE), push32(key), pushByte(ownerType), push32(owner), push32(name))
}

/**
 * The PENDING deed a `split` mints for `(key, claim)`, exactly as the gap covenant pins it.
 *
 * The owner field carries the claim, and the scheme byte is `Pubkey` because that is what the
 * covenant writes. A client can therefore derive a registration's address before broadcasting
 * it, and ask a node about that address afterwards. The state names no key until `activate`
 * reveals one.
 */
export function encodePendingDeedState(key: Uint8Array, claim: Uint8Array): Uint8Array {
  return concat(pushByte(STATUS_PENDING), push32(key), pushByte(OwnerType.Pubkey), push32(claim), push32(ZERO32))
}

const ZERO32 = new Uint8Array(32)

/** A gap's state: the open interval `(lo, hi)` of unregistered keyspace it covers. */
export function encodeGapState(lo: Uint8Array, hi: Uint8Array): Uint8Array {
  return concat(push32(lo), push32(hi))
}
