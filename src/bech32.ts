// Kaspa's bech32 variant: the version byte and payload in 5-bit groups, a 40-bit checksum, and
// the prefix folded into the checksum without a separator group.

import { InvalidAddressError } from './errors.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/** The address prefixes of the Kaspa networks, as `kaspanet/rusty-kaspa` names them. */
export const NETWORK_PREFIXES = ['kaspa', 'kaspatest', 'kaspasim', 'kaspadev'] as const
export type NetworkPrefix = (typeof NETWORK_PREFIXES)[number]

function isNetworkPrefix(prefix: string): prefix is NetworkPrefix {
  return (NETWORK_PREFIXES as readonly string[]).includes(prefix)
}
const GENERATOR = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]

/** Address versions, as the address encodes them. */
export const Version = {
  /** A 32-byte x-only schnorr public key. */
  PubKey: 0,
  /** A 33-byte compressed ECDSA public key. */
  PubKeyECDSA: 1,
  /** A 32-byte blake2b-256 of a redeem script. */
  ScriptHash: 8,
} as const

export interface Address {
  prefix: string
  version: number
  payload: Uint8Array
}

const PAYLOAD_LENGTH: Record<number, number> = {
  [Version.PubKey]: 32,
  [Version.PubKeyECDSA]: 33,
  [Version.ScriptHash]: 32,
}

function polymod(values: number[]): bigint {
  let c = 1n
  for (const d of values) {
    const top = c >> 35n
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
    GENERATOR.forEach((g, i) => {
      if ((top >> BigInt(i)) & 1n) c ^= g
    })
  }
  return c ^ 1n
}

function prefixValues(prefix: string): number[] {
  return Array.from(prefix, (ch) => ch.charCodeAt(0) & 31)
}

function toFiveBit(bytes: Uint8Array): number[] {
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const byte of bytes) {
    buf = (buf << 8) | byte
    for (bits += 8; bits >= 5; bits -= 5) out.push((buf >> (bits - 5)) & 31)
    buf &= (1 << bits) - 1
  }
  if (bits > 0) out.push((buf << (5 - bits)) & 31)
  return out
}

function fromFiveBit(groups: number[]): Uint8Array {
  const out: number[] = []
  let buf = 0
  let bits = 0
  for (const g of groups) {
    buf = (buf << 5) | g
    for (bits += 5; bits >= 8; bits -= 8) out.push((buf >> (bits - 8)) & 255)
    buf &= (1 << bits) - 1
  }
  // Padding is at most four zero bits, as the encoder wrote it.
  if (bits >= 5 || buf !== 0) throw new InvalidAddressError('address has a malformed payload')
  return Uint8Array.from(out)
}

export function encodeAddress(prefix: string, version: number, payload: Uint8Array): string {
  if (!isNetworkPrefix(prefix)) throw new InvalidAddressError(`unknown network prefix ${prefix}:`)
  const data = toFiveBit(new Uint8Array([version, ...payload]))
  const sum = polymod([...prefixValues(prefix), 0, ...data, 0, 0, 0, 0, 0, 0, 0, 0])
  const check = Array.from({ length: 8 }, (_, i) => Number((sum >> BigInt(35 - 5 * i)) & 31n))
  return `${prefix}:${[...data, ...check].map((v) => CHARSET[v]).join('')}`
}

/** Parse an address string. Make sure that the checksum and the payload length fit the version. */
export function decodeAddress(address: string): Address {
  const colon = address.indexOf(':')
  if (colon <= 0) throw new InvalidAddressError(`address has no network prefix: ${address}`)
  const prefix = address.slice(0, colon)
  const body = address.slice(colon + 1)
  // The checksum is computed over the prefix given, so it passes any prefix and the rule is what
  // refuses one, as rusty-kaspa refuses a prefix it does not name.
  if (!isNetworkPrefix(prefix)) throw new InvalidAddressError(`unknown network prefix ${prefix}: in ${address}`)
  if (body.length < 9 || body !== body.toLowerCase()) throw new InvalidAddressError(`not a Kaspa address: ${address}`)
  const groups = Array.from(body, (ch) => CHARSET.indexOf(ch))
  if (groups.includes(-1)) throw new InvalidAddressError(`not a Kaspa address: ${address}`)
  if (polymod([...prefixValues(prefix), 0, ...groups]) !== 0n) throw new InvalidAddressError(`bad checksum: ${address}`)
  const bytes = fromFiveBit(groups.slice(0, -8))
  const version = bytes[0]
  const payload = bytes.slice(1)
  const expected = version === undefined ? undefined : PAYLOAD_LENGTH[version]
  if (version === undefined || expected === undefined)
    throw new InvalidAddressError(`unknown address version in ${address}`)
  if (payload.length !== expected) {
    throw new InvalidAddressError(`address version ${version} needs a ${expected}-byte payload, got ${payload.length}`)
  }
  return { prefix, version, payload }
}
