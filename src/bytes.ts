const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/** Strict: even length, lowercase or uppercase hex, nothing else. */
export function fromHex(hex: string, what = 'hex'): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError(`${what} is not hex: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** A 32-byte value from its 64 hex characters. */
export function hex32(hex: string, what: string): Uint8Array {
  const bytes = fromHex(hex, what)
  if (bytes.length !== 32) throw new TypeError(`${what} must be 32 bytes, got ${bytes.length}`)
  return bytes
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Strict lexicographic order on equal-length keys, which is the covenant's `keyLt`. */
export function lessThan(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b),
}
