import { secp256k1 } from '@noble/curves/secp256k1.js'
import { type Address, Version, decodeAddress, encodeAddress } from './bech32.js'
import { InvalidAddressError, SubnameError } from './errors.js'
import { OwnerType, isOwnerType, isSpenderType } from './state.js'

/** A KCC-2 owner record as a deed stores it. */
export interface Owner {
  /** The scheme byte. See {@link OwnerType}. */
  ownerType: number
  /** The 32-byte owner payload, hex. */
  owner: string
}

/** An owner pair with its payload as bytes: what a deed stores, and what a `sub:` value holds. `Owner` is the same pair as hex. */
export interface OwnerBytes {
  ownerType: number
  owner: Uint8Array
}

/**
 * The owner record an address stands for. Every address kind maps to exactly one scheme, so a
 * name has exactly one deed address to derive and probe. A schnorr or P2SH address stores its
 * payload as is. An ECDSA address stores its key's x, with the y-parity in the scheme byte.
 */
export function ownerOfParsed(address: Address): OwnerBytes {
  switch (address.version) {
    case Version.PubKey:
      return { ownerType: OwnerType.Pubkey, owner: address.payload }
    case Version.ScriptHash:
      return { ownerType: OwnerType.ScriptHash, owner: address.payload }
    case Version.PubKeyECDSA: {
      const sec1 = address.payload[0]
      if (sec1 !== 0x02 && sec1 !== 0x03)
        throw new InvalidAddressError(`ECDSA address has SEC1 prefix ${sec1}, expected 2 or 3`)
      return {
        ownerType: sec1 === 0x02 ? OwnerType.P2pkEcdsaEven : OwnerType.P2pkEcdsaOdd,
        owner: address.payload.slice(1),
      }
    }
    default:
      throw new InvalidAddressError(`unsupported address version ${address.version}`)
  }
}

/** The address a stored owner came from, or undefined for a covenant owner, which has none. */
export function ownerAddress(prefix: string, ownerType: number, owner: Uint8Array): string | undefined {
  switch (ownerType) {
    case OwnerType.Pubkey:
      return encodeAddress(prefix, Version.PubKey, owner)
    case OwnerType.ScriptHash:
      return encodeAddress(prefix, Version.ScriptHash, owner)
    case OwnerType.P2pkEcdsaEven:
    case OwnerType.P2pkEcdsaOdd:
      return encodeAddress(prefix, Version.PubKeyECDSA, new Uint8Array([0x02 | (ownerType & 1), ...owner]))
    case OwnerType.CovenantId:
      return undefined
    default:
      throw new InvalidAddressError(`unknown owner type ${ownerType}`)
  }
}

/**
 * The tests an owner payload passes. It throws {@link SubnameError} tagged `bad-scheme`,
 * `zero-payload` or `not-a-point` for a pair no key can answer for. A payload that is not 32
 * bytes is a caller's bug and gets a `TypeError`.
 *
 * A key-owned scheme stores the key itself, so a payload off the curve names a party no
 * signature can answer for. A script hash and a covenant id commit to a preimage nobody here can
 * know, so any non-zero payload passes under those two. {@link isSpenderType} names the key
 * schemes, and a scheme added later takes the curve test only once it is named there too.
 */
export function checkPayload(ownerType: number, owner: Uint8Array): void {
  if (owner.length !== 32) throw new TypeError(`owner must be 32 bytes, got ${owner.length}`)
  // The scheme byte first. A byte this registry does not dispatch on names no party at all, so
  // no payload under it can pass.
  if (!isOwnerType(ownerType)) throw new SubnameError('the value names no owner scheme', 'bad-scheme')
  if (owner.every((b) => b === 0)) throw new SubnameError('the payload is 32 zero bytes', 'zero-payload')
  if (!isSpenderType(ownerType)) return
  // Exactly the key the covenant rebuilds: `0x02 | (scheme & 1)` followed by the payload. A
  // schnorr payload is the x of a point with even y, which is the same test under `0x02`.
  const compressed = new Uint8Array(33)
  compressed[0] = 0x02 | (ownerType & 0x01)
  compressed.set(owner, 1)
  try {
    secp256k1.Point.fromBytes(compressed)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw new SubnameError(`the payload is not a point on the secp256k1 curve (${why})`, 'not-a-point')
  }
}

/** Parse an address and require it to be on the registry's network. */
export function parseAddress(address: string, prefix: string): Address {
  const parsed = decodeAddress(address)
  if (parsed.prefix !== prefix) {
    throw new InvalidAddressError(`${address} is a ${parsed.prefix}: address. This registry lives on ${prefix}:`)
  }
  return parsed
}
