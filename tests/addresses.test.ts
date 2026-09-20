import { describe, expect, it } from 'vitest'
import { OwnerType, isOwnerType } from '../src/state.js'
import { NETWORK_PREFIXES, decodeAddress, encodeAddress } from '../src/bech32.js'
import { fromHex, toHex } from '../src/bytes.js'
import { InvalidAddressError, SubnameError } from '../src/errors.js'
import { MANIFEST_VERSION, loadRegistry, prefixFor } from '../src/manifest.js'
import { checkPayload, ownerAddress, ownerOfParsed as ownerOf } from '../src/owner.js'
import { DEED_STATE_LEN, GAP_STATE_LEN, encodeActiveDeedState, encodeGapState } from '../src/state.js'
import { keyBytesOf, paddedName } from '../src/names.js'
import { vectors } from './vectors.js'
import { DEPLOYMENTS } from '../src/deployments.js'

// The same registry the corpus was written from, whichever one is listed first.
const genesis = DEPLOYMENTS[vectors.manifest.network]!
const registry = loadRegistry(genesis)

describe('owner records', () => {
  it.each(vectors.owner)('$network $ownerType', ({ network, ownerType, owner, address }) => {
    expect(ownerAddress(prefixFor(network), ownerType, fromHex(owner)) ?? null).toBe(address)
    if (address !== null) {
      const back = ownerOf(decodeAddress(address))
      expect(back.ownerType).toBe(ownerType)
      expect(toHex(back.owner)).toBe(owner)
    }
  })
})

describe('bech32', () => {
  it.each(vectors.owner.filter((v) => v.address !== null))('round-trips $address', ({ address }) => {
    const parsed = decodeAddress(address!)
    expect(encodeAddress(parsed.prefix, parsed.version, parsed.payload)).toBe(address)
  })

  it('refuses a corrupted address, a wrong length and an unknown version', () => {
    const good = vectors.owner.find((v) => v.address !== null)!.address!
    const flipped = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q')
    expect(() => decodeAddress(flipped)).toThrow(InvalidAddressError)
    expect(() => decodeAddress(good.toUpperCase())).toThrow(InvalidAddressError)
    // An uppercase prefix checksums the same, because the checksum keeps five bits of each
    // character. rusty-kaspa refuses it, so this decoder does.
    const colon = good.indexOf(':')
    expect(() => decodeAddress(good.slice(0, colon).toUpperCase() + good.slice(colon))).toThrow(InvalidAddressError)
    // A digit or a mark in the prefix checksums like the letter it shares five bits with, and is refused by rule.
    expect(() => decodeAddress('kas0a' + good.slice(colon))).toThrow(InvalidAddressError)
    expect(() => decodeAddress('kasp!' + good.slice(colon))).toThrow(InvalidAddressError)
    expect(() => decodeAddress('kaspa')).toThrow(InvalidAddressError)
    // A prefix that names no Kaspa network is refused by rule, on both sides, ahead of the
    // checksum, which is computed over the prefix given and so would pass.
    const parsed = decodeAddress(good)
    expect(() => decodeAddress('kaspaz' + good.slice(colon))).toThrow(/unknown network prefix/)
    expect(() => encodeAddress('kaspaz', parsed.version, parsed.payload)).toThrow(/unknown network prefix/)
    for (const prefix of NETWORK_PREFIXES)
      expect(decodeAddress(encodeAddress(prefix, parsed.version, parsed.payload)).prefix).toBe(prefix)
    // The registry's prefixes are the same four.
    expect(['mainnet', 'testnet-10', 'simnet', 'devnet'].map(prefixFor)).toEqual([...NETWORK_PREFIXES])
    expect(() => decodeAddress(encodeAddress('kaspa', 0, new Uint8Array(31)))).toThrow(/32-byte payload/)
    expect(() => decodeAddress(encodeAddress('kaspa', 2, new Uint8Array(32)))).toThrow(/unknown address version/)
  })
})

describe('deed addresses', () => {
  it.each(vectors.deedAddress)('$network $name $ownerType', ({ network, name, ownerType, owner, state, address }) => {
    const encoded = encodeActiveDeedState(keyBytesOf(name), ownerType, fromHex(owner), paddedName(name))
    expect(toHex(encoded)).toBe(state)
    expect(registry.deed.address(prefixFor(network), encoded).text).toBe(address)
  })
})

describe('gap addresses', () => {
  it.each(vectors.gapAddress)('$lo..$hi', ({ network, lo, hi, state, address }) => {
    const encoded = encodeGapState(fromHex(lo), fromHex(hi))
    expect(toHex(encoded)).toBe(state)
    expect(registry.gap.address(prefixFor(network), encoded).text).toBe(address)
  })
})

describe('the manifest pin', () => {
  it('refuses bytecode that does not reproduce the pinned hash', () => {
    const forged = structuredClone(genesis)
    forged.deedAbi.contracts.DotkDeed.compiled.bytecode[200]! ^= 1
    expect(() => loadRegistry(forged)).toThrow(/deed template/)
  })

  it('refuses a state span outside the bytecode', () => {
    const forged = structuredClone(genesis)
    forged.gapAbi.contracts.DotkGap.compiled.state_span.offset = 1 << 30
    expect(() => loadRegistry(forged)).toThrow(/gap template/)
  })

  it('refuses a manifest written to another shape', () => {
    // `genesis` is a public option, so a manifest from a later generator can arrive here.
    // Read as far as it happens to parse, it costs a wrong address rather than a refusal.
    expect(genesis.version).toBe(MANIFEST_VERSION)
    const later = structuredClone(genesis)
    later.version = MANIFEST_VERSION + 1
    expect(() => loadRegistry(later)).toThrow(/manifest version/)
  })
})

describe('the state lengths', () => {
  /** The two published widths tie to what the encoders write and to what the bundled templates expect. */
  it('are the widths the encoders write and the templates take', () => {
    const owner = new Uint8Array(32).fill(1)
    expect(encodeActiveDeedState(keyBytesOf('a'), OwnerType.Pubkey, owner, paddedName('a')).length).toBe(DEED_STATE_LEN)
    expect(encodeGapState(new Uint8Array(32), new Uint8Array(32).fill(0xff)).length).toBe(GAP_STATE_LEN)
    for (const manifest of Object.values(DEPLOYMENTS)) {
      const registry = loadRegistry(manifest)
      expect(registry.deed.stateLen).toBe(DEED_STATE_LEN)
      expect(registry.gap.stateLen).toBe(GAP_STATE_LEN)
    }
  })
})

describe('the owner schemes', () => {
  it('are exactly the five bytes the covenant dispatches on, and nothing left over', () => {
    // The corpus replays every scheme it carries, which catches a missing or wrong value and
    // never an extra one; a stale byte here would gate API rows and derive addresses for a
    // scheme the chain refuses.
    expect([...Object.values(OwnerType)].sort((a, b) => a - b)).toEqual([0x00, 0x03, 0x04, 0x85, 0x86])
    expect(OwnerType.P2pkEcdsaOdd & 1).toBe(1)
    expect(OwnerType.P2pkEcdsaEven & 1).toBe(0)
    for (const b of [0x01, 0x02, 0x05, 0x06, 0x80, 0x81, 0x84, 0x87, 0xff]) expect(isOwnerType(b)).toBe(false)
  })
})

/**
 * The payload tests an owner passes, which a subname value passes too. The corpus holds the
 * payloads, so the pairs here are the ones the reference implementation judged.
 */
describe('checkPayload', () => {
  const ZERO = new Uint8Array(32)
  const OFF_CURVE = fromHex('ff'.repeat(32))
  const KEY_SCHEMES = [OwnerType.Pubkey, OwnerType.P2pkEcdsaEven, OwnerType.P2pkEcdsaOdd]
  const COMMITTING = [OwnerType.ScriptHash, OwnerType.CovenantId]
  const onCurve = vectors.subnameValue.filter((v) => v.value !== undefined)

  const tagOf = (run: () => unknown): string => {
    try {
      run()
    } catch (e) {
      if (e instanceof SubnameError) return e.tag
      return `${(e as Error).name}: ${(e as Error).message}`
    }
    return 'no fault'
  }

  it('takes every payload the corpus writes a subname value for', () => {
    expect(onCurve.length).toBeGreaterThan(0)
    for (const v of onCurve) expect(() => checkPayload(v.ownerType, fromHex(v.owner)), `${v.ownerType}`).not.toThrow()
  })

  it('refuses a zero payload under every scheme, before any curve test', () => {
    for (const scheme of [...KEY_SCHEMES, ...COMMITTING])
      expect(
        tagOf(() => checkPayload(scheme, ZERO)),
        `${scheme}`
      ).toBe('zero-payload')
  })

  /**
   * The bricking guard. A key scheme stores the key itself, so a payload off the curve names a
   * party that no signature can answer for. A scheme committing to a preimage nobody here can
   * know takes any non-zero value, because no client can test one.
   */
  it('refuses an x that is no curve point under a key scheme, and takes one under the rest', () => {
    for (const scheme of KEY_SCHEMES)
      expect(
        tagOf(() => checkPayload(scheme, OFF_CURVE)),
        `${scheme}`
      ).toBe('not-a-point')
    for (const scheme of COMMITTING) expect(() => checkPayload(scheme, OFF_CURVE), `${scheme}`).not.toThrow()
  })

  it('names the curve in the message, because that is what the reader has to act on', () => {
    expect(() => checkPayload(OwnerType.Pubkey, OFF_CURVE)).toThrow(/secp256k1/)
  })

  /** The parity lives in the scheme byte, so the two ECDSA schemes judge one x differently. */
  it('reads an ECDSA payload under the parity its scheme names', () => {
    const even = onCurve.find((v) => v.ownerType === OwnerType.P2pkEcdsaEven)!
    const odd = onCurve.find((v) => v.ownerType === OwnerType.P2pkEcdsaOdd)!
    expect(() => checkPayload(OwnerType.P2pkEcdsaEven, fromHex(even.owner))).not.toThrow()
    expect(() => checkPayload(OwnerType.P2pkEcdsaOdd, fromHex(odd.owner))).not.toThrow()
    // The twin point of the same x is on the curve too, so a parity swap is not a refusal.
    expect(() => checkPayload(OwnerType.P2pkEcdsaOdd, fromHex(even.owner))).not.toThrow()
  })

  it('refuses a payload that is not 32 bytes at all', () => {
    expect(() => checkPayload(OwnerType.Pubkey, new Uint8Array(31))).toThrow(TypeError)
  })

  /** A byte the registry does not dispatch on names no party, so no payload under it can pass. */
  it('refuses a scheme byte that is no owner scheme, before it reads the payload', () => {
    const good = fromHex(onCurve.find((v) => v.ownerType === OwnerType.Pubkey)!.owner)
    for (const scheme of [0x01, 0x02, 0x05, 0x84, 0x87, 0xfe]) {
      expect(
        tagOf(() => checkPayload(scheme, good)),
        `${scheme}`
      ).toBe('bad-scheme')
      expect(
        tagOf(() => checkPayload(scheme, ZERO)),
        `${scheme}`
      ).toBe('bad-scheme')
    }
  })
})
