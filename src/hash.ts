import { blake2b } from '@noble/hashes/blake2.js'
import { blake3 as nobleBlake3 } from '@noble/hashes/blake3.js'
import { concat } from './bytes.js'

/** blake2b-256, the hash Kaspa's P2SH commits a redeem script with. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 })
}

/** blake3, the KCC-1 standard hash: name keys and template hashes. */
export function blake3(data: Uint8Array): Uint8Array {
  return nobleBlake3(data)
}

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}

/**
 * The template hash the covenants pin each other with. It is blake3 over the fixed bytes around
 * the state span, with each part prefixed by its length as a little-endian u64.
 */
export function templateHash(prefix: Uint8Array, suffix: Uint8Array): Uint8Array {
  return blake3(concat(le64(prefix.length), prefix, le64(suffix.length), suffix))
}
