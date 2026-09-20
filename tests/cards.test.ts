import { describe, expect, it } from 'vitest'
import { concat, fromHex, toHex, utf8 } from '../src/bytes.js'
import {
  CARD_BLOB_MAX,
  CARD_MAGIC,
  CARD_PAYLOAD_VERSION,
  CARD_STATE_LEN,
  CARD_VALUE,
  CardError,
  PRIMARY_KEY,
  RECORD_DEPTH_MAX,
  RECORD_KEYS,
  type CardMint,
  cardAddress,
  cardRedeemScript,
  cardScriptPublicKey,
  cardState,
  decodeCardPayload,
  decodeCardState,
  decodeRecords,
  encodeCardPayload,
  encodeCardState,
  encodeRecords,
  recordsOf,
  subnameKey,
  subnameOf,
  subnamePair,
  subnameValue,
  subnames,
  sweepSigScript,
  verifyCard,
} from '../src/cards.js'
import { keyBytesOf, splitSubname } from '../src/names.js'
import { OwnerType } from '../src/state.js'
import { prefixFor } from '../src/manifest.js'
import { SubnameError } from '../src/errors.js'
import { DEPLOYMENT_NETWORKS } from '../src/deployments.js'
import { CORPORA, vectors } from './vectors.js'

const SPENDER = fromHex('11'.repeat(32))

/**
 * Every card derivation, replayed against what the corpus holds for the same inputs. The blob
 * matters most: two encoders that disagree on a byte disagree on the hash, and the hash is what
 * the card commits to.
 */
describe('the card vectors', () => {
  it.each(vectors.card)('$name on $network, spender scheme $spenderType', (v) => {
    const blob = encodeRecords(v.records)
    expect(toHex(blob)).toBe(v.blob)
    expect(toHex(recordsOf(blob))).toBe(v.recordsHash)
    expect(decodeRecords(blob)).toEqual(v.records)

    const state = cardState(keyBytesOf(v.name), recordsOf(blob), v.spenderType, fromHex(v.spender))
    expect(toHex(encodeCardState(state))).toBe(v.state)
    expect(decodeCardState(fromHex(v.state))).toEqual(state)
    expect(toHex(cardRedeemScript(state))).toBe(v.redeemScript)
    expect(toHex(cardScriptPublicKey(state))).toBe(v.spk)
    expect(cardAddress(prefixFor(v.network), state)).toBe(v.address)
    expect(toHex(sweepSigScript(state))).toBe(v.sweepSigScript)

    expect(toHex(encodeCardPayload({ state, blob }))).toBe(v.payload)
    expect(decodeCardPayload(fromHex(v.payload))).toEqual({ state, blob })
  })
})

describe('the record blob', () => {
  it('encodes one set to one blob whatever order the keys come in', () => {
    const a = encodeRecords({ url: 'https://kaspa.org', avatar: 'x', [PRIMARY_KEY]: true })
    const b = encodeRecords({ [PRIMARY_KEY]: true, avatar: 'x', url: 'https://kaspa.org' })
    expect(toHex(a)).toBe(toHex(b))
  })

  it('sorts keys by their encoded bytes, so a prefix key comes before its extension', () => {
    // "com.github" (10 bytes) sorts before "com.githubx" (11 bytes) under length-first
    // encoding, and "url" (3 bytes) before both: the head byte carries the length.
    const blob = encodeRecords({ 'com.githubx': '', 'com.github': 'kaspanet', url: 'u' })
    expect(Object.keys(decodeRecords(blob))).toEqual(['url', 'com.github', 'com.githubx'])
  })

  it('encodes an empty set as an empty map', () => {
    expect(toHex(encodeRecords({}))).toBe('a0')
    expect(decodeRecords(fromHex('a0'))).toEqual({})
  })

  it('refuses a set over the cap, and a blob over it', () => {
    expect(() => encodeRecords({ avatar: 'x'.repeat(CARD_BLOB_MAX) })).toThrow(CardError)
    expect(() => decodeRecords(new Uint8Array(CARD_BLOB_MAX + 1))).toThrow(/cap/)
    // Just under it encodes: the cap is on the blob, not the value.
    expect(encodeRecords({ a: 'x'.repeat(CARD_BLOB_MAX - 8) }).length).toBeLessThanOrEqual(CARD_BLOB_MAX)
  })

  it('refuses a value that is neither text, a flag nor an opaque value', () => {
    expect(() => encodeRecords({ n: 1 as unknown as string })).toThrow(CardError)
    // A lone surrogate is no UTF-8. The encoder would write U+FFFD in its place, and the blob
    // would decode to a set other than the one given.
    expect(() => encodeRecords({ url: 'x\uD800y' })).toThrow(/lone surrogate/)
    expect(() => encodeRecords({ ['k\uDC00']: 'v' })).toThrow(/lone surrogate/)
    expect(toHex(encodeRecords({ url: '\uD83D\uDE00' }))).toBe(toHex(encodeRecords({ url: '😀' })))
    expect(() => encodeRecords({ n: { x: 1 } as unknown as string })).toThrow(CardError)
  })

  it('accepts upper-case hex in an opaque value and writes the bytes it names', () => {
    expect(toHex(encodeRecords({ x: { opaque: '182A' } }))).toBe('a16178182a')
  })

  it('converts an opaque value it recognises at the encoder, and refuses one it cannot carry', () => {
    // A text item and a flag byte become that record, as the reference implementation converts them.
    expect(toHex(encodeRecords({ t: { opaque: '6161' } }))).toBe(toHex(encodeRecords({ t: 'a' })))
    expect(toHex(encodeRecords({ f: { opaque: 'f5' } }))).toBe(toHex(encodeRecords({ f: true })))
    for (const [hex, why] of [
      ['', /empty/],
      ['ff', /unsupported/],
      ['8201', /truncated/],
      ['0102', /one CBOR item/],
      ['61ff', /not UTF-8/],
      ['zz', /not hex/],
      ['81'.repeat(RECORD_DEPTH_MAX + 1) + '01', /too deep/],
    ] as const) {
      expect(() => encodeRecords({ x: { opaque: hex } }), hex).toThrow(why)
    }
  })

  it.each([
    ['not a map', '80', /not a CBOR map/],
    ['a non-text key', 'a10101', /not text/],
    ['a truncated blob', 'a2616161', /truncated/],
    ['trailing bytes', 'a0ff', /trailing/],
    ['a duplicate key', 'a26161f56161f4', /twice/],
    ['an indefinite length', 'bf', /unsupported/],
    ['invalid UTF-8', 'a161ff6161', /UTF-8/],
  ])('refuses %s', (_, hex, why) => {
    expect(() => decodeRecords(fromHex(hex))).toThrow(why)
  })

  it('carries a value it does not recognise, byte for byte', () => {
    // {"a": null}: not text and not a flag, so it is carried.
    const records = decodeRecords(fromHex('a16161f6'))
    expect(records).toEqual({ a: { opaque: 'f6' } })
    expect(toHex(encodeRecords(records))).toBe('a16161f6')
  })

  it('reads a map with the keys in any order and with flags either way', () => {
    // {"b": false, "a": "x"}: not sorted, and a false flag.
    expect(decodeRecords(fromHex('a26162f461616178'))).toEqual({ b: false, a: 'x' })
  })

  it('keeps a __proto__ key as a record rather than a prototype', () => {
    const blob = encodeRecords({ ['__proto__']: 'x' })
    const records = decodeRecords(blob)
    expect(Object.getPrototypeOf(records)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(records, '__proto__')?.value).toBe('x')
  })

  it('names the ENSIP-5 keys and the local primary key', () => {
    expect(RECORD_KEYS.global).toContain('avatar')
    expect(RECORD_KEYS.service).toContain('com.github')
    expect(RECORD_KEYS.local).toEqual([PRIMARY_KEY])
    expect(PRIMARY_KEY).toBe('primary')
  })
})

/** The tolerant decoder, replayed against what the corpus holds for the same blobs. */
describe('the decoder vectors', () => {
  it.each(vectors.recordsDecode)('$what', (v) => {
    if (v.fault !== undefined) {
      expect(() => decodeRecords(fromHex(v.blob))).toThrow(v.fault)
      return
    }
    const records = decodeRecords(fromHex(v.blob))
    expect(records).toEqual(v.records)
    expect(toHex(encodeRecords(records))).toBe(v.reencoded)
  })
})

describe('the card state', () => {
  const key = keyBytesOf('kaspa')
  const records = recordsOf(encodeRecords({}))

  it('is 97 bytes and holds 0.5 KAS', () => {
    expect(CARD_STATE_LEN).toBe(97)
    expect(CARD_VALUE).toBe(50_000_000)
    expect(encodeCardState(cardState(key, records, OwnerType.Pubkey, SPENDER))).toHaveLength(CARD_STATE_LEN)
  })

  it('refuses a spender no signature satisfies', () => {
    expect(() => cardState(key, records, OwnerType.ScriptHash, SPENDER)).toThrow(/scheme 3 has none/)
    expect(() => cardState(key, records, OwnerType.CovenantId, SPENDER)).toThrow(CardError)
    expect(() => cardState(key, records, OwnerType.Pubkey, new Uint8Array(32))).toThrow(/zero/)
    expect(() => decodeCardState(new Uint8Array(96))).toThrow(/97 bytes/)
  })

  it('builds the ECDSA script over the compressed key with its parity from the scheme', () => {
    const even = cardRedeemScript(cardState(key, records, OwnerType.P2pkEcdsaEven, SPENDER))
    const odd = cardRedeemScript(cardState(key, records, OwnerType.P2pkEcdsaOdd, SPENDER))
    expect(even).toHaveLength(109)
    expect(even[even.length - 34]).toBe(0x02)
    expect(odd[odd.length - 34]).toBe(0x03)
    expect(even[even.length - 1]).toBe(0xab) // OP_CHECKSIGECDSA
    expect(cardRedeemScript(cardState(key, records, OwnerType.Pubkey, SPENDER))).toHaveLength(108)
  })

  it('refuses a sweep signature of the wrong length', () => {
    expect(() => sweepSigScript(cardState(key, records, OwnerType.Pubkey, SPENDER), new Uint8Array(64))).toThrow(
      /65 bytes/
    )
  })
})

describe('the card payload', () => {
  const blob = encodeRecords({ url: 'u' })
  const state = cardState(keyBytesOf('kaspa'), recordsOf(blob), OwnerType.Pubkey, SPENDER)

  /** Bytes declaring as many cards as asked for, which the encoder itself will not write. */
  function payloadOf(cards: CardMint[]): Uint8Array {
    const parts = [CARD_MAGIC, Uint8Array.of(CARD_PAYLOAD_VERSION)]
    for (const c of cards) {
      parts.push(encodeCardState(c.state), Uint8Array.of(c.blob.length & 0xff, c.blob.length >> 8), c.blob)
    }
    return concat(...parts)
  }

  it('is empty for no mint and null for bytes that are not ours', () => {
    expect(encodeCardPayload(null)).toHaveLength(0)
    expect(decodeCardPayload(new Uint8Array(0))).toBeNull()
    expect(decodeCardPayload(utf8.encode('hello world'))).toBeNull()
  })

  it('carries the one card and reads it back', () => {
    expect(decodeCardPayload(encodeCardPayload({ state, blob }))).toEqual({ state, blob })
  })

  it('refuses a second card, because a name holds one', () => {
    const other = cardState(keyBytesOf('a'), recordsOf(blob), OwnerType.P2pkEcdsaOdd, SPENDER)
    expect(() =>
      decodeCardPayload(
        payloadOf([
          { state, blob },
          { state: other, blob },
        ])
      )
    ).toThrow(/after its card/)
  })

  it('refuses a byte after the blob', () => {
    expect(() => decodeCardPayload(concat(payloadOf([{ state, blob }]), Uint8Array.of(0)))).toThrow(/after its card/)
  })

  it('refuses a state that does not commit to its blob, on the way out and on the way in', () => {
    const wrong = { ...state, records: recordsOf(utf8.encode('other')) }
    expect(() => encodeCardPayload({ state: wrong, blob })).toThrow(/commit/)
    const payload = encodeCardPayload({ state, blob })
    payload[payload.length - 1]! ^= 1
    expect(() => decodeCardPayload(payload)).toThrow(/commit/)
  })

  it.each([
    ['another version', '646f746b02', /version 2/],
    ['no card', '646f746b01', /truncated inside a state/],
    ['a truncated state', '646f746b01' + '00'.repeat(10), /truncated inside a state/],
  ])('refuses %s', (_, hex, why) => {
    expect(() => decodeCardPayload(fromHex(hex))).toThrow(why)
  })
})

describe('the five rules', () => {
  const blob = encodeRecords({ [PRIMARY_KEY]: true })
  const deed = { key: keyBytesOf('kaspa'), outpointTxid: 'aa'.repeat(32) }
  const card = cardState(deed.key, recordsOf(blob), OwnerType.Pubkey, SPENDER)
  const live = { transactionId: 'AA'.repeat(32), index: 1 }

  it('accept a card minted with the deed, whose blob hashes to its commitment', () => {
    expect(() => verifyCard(deed, card, live, blob)).not.toThrow()
  })

  it('refuse a card for another name', () => {
    expect(() => verifyCard({ ...deed, key: keyBytesOf('a') }, card, live, blob)).toThrow(/another name/)
  })

  it('rule 1: refuse a card with no UTXO', () => {
    expect(() => verifyCard(deed, card, undefined, blob)).toThrow(/rule 1/)
  })

  it('rule 2: refuse a card minted in another transaction than the deed', () => {
    expect(() => verifyCard(deed, card, { transactionId: 'bb'.repeat(32), index: 1 }, blob)).toThrow(/rule 2/)
  })

  it('rule 2: refuse a card at another output of the deed transaction', () => {
    expect(() => verifyCard(deed, card, { transactionId: deed.outpointTxid, index: 2 }, blob)).toThrow(/rule 2/)
  })

  it('rule 3: refuse a blob the card does not commit to', () => {
    expect(() => verifyCard(deed, card, live, encodeRecords({}))).toThrow(/rule 3/)
  })

  it('rule 4: refuse a blob over the cap before hashing it', () => {
    const big = new Uint8Array(CARD_BLOB_MAX + 1)
    const claims = cardState(deed.key, recordsOf(big), OwnerType.Pubkey, SPENDER)
    expect(() => verifyCard(deed, claims, live, big)).toThrow(/rule 4/)
  })
})

/** The tag a call threw, so that a case names the fault rather than only that there was one. */
function tagOf(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    if (e instanceof SubnameError) return e.tag
    return `${(e as Error).name}: ${(e as Error).message}`
  }
  return 'no fault'
}

/**
 * The three subname rules, replayed per registry as `deployments.test.ts` replays the
 * addresses. Each row names its own network, because a payee is rendered with a prefix and not
 * carried with one.
 */
describe.each(DEPLOYMENT_NETWORKS)('the subname vectors of %s', (network) => {
  const corpus = CORPORA[network]!

  it.each(corpus.subname)('row %# resolves $input under owner scheme $ownerType', (v) => {
    // Rule 1 refused the input, so nothing reads a card at all.
    if (v.parent === undefined && v.label === undefined) {
      expect(tagOf(() => splitSubname(v.input))).toBe(v.fault)
      return
    }
    const { parent, label } = splitSubname(v.input)
    expect(parent).toBe(v.parent)
    expect(label).toBe(v.label ?? null)
    // A bare name is the name's own answer, and the corpus carries neither payee nor fault.
    if (label === null) {
      expect(v.address).toBeUndefined()
      expect(v.fault).toBeUndefined()
      return
    }
    const prefix = prefixFor(v.network)
    if (v.fault !== undefined) {
      expect(tagOf(() => subnameOf(v.ownerType, v.records, label, prefix))).toBe(v.fault)
      return
    }
    // Where the row carries no address either, the card holds no such key.
    expect(subnameOf(v.ownerType, v.records, label, prefix)).toBe(v.address ?? null)
  })

  it.each(corpus.subnameList)('row %# lists a card under owner scheme $ownerType', (v) => {
    // From the blob, so the sort is what puts the listing in key order. The decoder answers in
    // the blob's own order, shortest key first, which is another order.
    const records = decodeRecords(fromHex(v.blob))
    expect(records).toEqual(v.records)
    const expected = v.entries.map((e) =>
      e.fault === undefined ? { label: e.label, address: e.address } : { label: e.label, address: null, fault: e.fault }
    )
    expect(subnames(v.ownerType, records, prefixFor(v.network))).toEqual(expected)
  })

  it.each(corpus.subnameValue)('row %# writes the value of owner scheme $ownerType', (v) => {
    const owner = fromHex(v.owner)
    if (v.fault !== undefined) {
      expect(tagOf(() => subnameValue(v.ownerType, owner))).toBe(v.fault)
      return
    }
    const value = subnameValue(v.ownerType, owner)
    expect(value).toEqual(v.value)
    // What the writer wrote is what a reader takes back, which is the one item shape rule 3 has.
    const pair = subnamePair(subnameKey('bob'), value)
    expect(pair.ownerType).toBe(v.ownerType)
    expect(toHex(pair.owner)).toBe(v.owner)
  })
})

describe('a subname key and one stored entry', () => {
  const payee = vectors.subnameValue.find((v) => v.value !== undefined && v.ownerType === OwnerType.Pubkey)!
  const value = payee.value!

  it('holds the label rule on the way in', () => {
    expect(subnameKey('bob')).toBe('sub:bob')
    expect(subnameKey('dev.team')).toBe('sub:dev.team')
    for (const bad of ['', 'Bob', 'k', 'z'.repeat(65)])
      expect(
        tagOf(() => subnameKey(bad)),
        bad
      ).toBe('bad-label')
  })

  /**
   * The scheme byte is judged before the payload. `checkPayload` measures the width first, so a
   * pair that is wrong in both ways answers about the scheme rather than about the bytes.
   */
  it('judges the scheme before it reads the payload', () => {
    expect(tagOf(() => subnameValue(0xfe, new Uint8Array(31)))).toBe('bad-scheme')
    expect(tagOf(() => subnameValue(OwnerType.Pubkey, new Uint8Array(31)))).toMatch(/^TypeError: /)
  })

  it('refuses a key that carries no prefix, and says so rather than judging the label', () => {
    expect(tagOf(() => subnamePair('url', value))).toBe('bad-label')
    expect(() => subnamePair('url', value)).toThrow(/carries no sub: prefix/)
  })

  it('refuses every byte-string shape but the one the writer produces', () => {
    const x = payee.owner
    for (const [opaque, why] of [
      ['5900' + '21' + '00' + x, 'a two-byte length head'],
      ['5a000000' + '21' + '00' + x, 'a four-byte length head'],
      ['5f5821' + '00' + x + 'ff', 'the indefinite-length head'],
      ['5821' + '00' + x + '00', 'one trailing byte past the item'],
      ['5821' + '00' + 'aa'.repeat(31), 'the right head over a body one byte short'],
      ['58', 'a head that carries no length'],
      ['5821', 'a head that promises 33 bytes and carries none'],
      ['57'.repeat(24), 'a short-form byte string'],
    ] as const) {
      expect(
        tagOf(() => subnamePair('sub:bob', { opaque })),
        why
      ).toBe('bad-length')
    }
    // An empty value is no item at all, and an integer item is not a byte string.
    for (const opaque of ['', '182a', 'zz'])
      expect(
        tagOf(() => subnamePair('sub:bob', { opaque })),
        opaque
      ).toBe('not-bytes')
    for (const other of ['kaspa:qqq', true] as const)
      expect(
        tagOf(() => subnamePair('sub:bob', other)),
        String(other)
      ).toBe('not-bytes')
  })

  it('answers nothing for a covenant parent and for a key the card does not hold', () => {
    const prefix = prefixFor(vectors.manifest.network)
    const records = { 'sub:bob': value }
    expect(tagOf(() => subnameOf(OwnerType.CovenantId, records, 'bob', prefix))).toBe('parent-in-covenant')
    // The owner scheme is settled before the key lookup. A label the card does not hold is
    // therefore still the covenant's fault, rather than an empty answer.
    expect(tagOf(() => subnameOf(OwnerType.CovenantId, records, 'pay', prefix))).toBe('parent-in-covenant')
    expect(tagOf(() => subnameOf(OwnerType.CovenantId, {}, 'bob', prefix))).toBe('parent-in-covenant')
    expect(subnameOf(OwnerType.Pubkey, records, 'pay', prefix)).toBeNull()
    expect(subnameOf(OwnerType.Pubkey, {}, 'bob', prefix)).toBeNull()
    // The lookup normalizes nothing, so a stored `sub:Bob` stays unreachable.
    expect(tagOf(() => subnameOf(OwnerType.Pubkey, records, 'Bob', prefix))).toBe('bad-label')
  })

  it('lists only the sub: keys of a card, and nothing else on it', () => {
    const prefix = prefixFor(vectors.manifest.network)
    const listed = subnames(
      OwnerType.Pubkey,
      { url: 'https://alice.example', [PRIMARY_KEY]: true, 'sub:bob': value },
      prefix
    )
    expect(listed.map((e) => e.label)).toEqual(['bob'])
    expect(listed[0]!.address).toBe(subnameOf(OwnerType.Pubkey, { 'sub:bob': value }, 'bob', prefix))
    // A readable entry omits the key rather than carrying an undefined one, which is what
    // `exactOptionalPropertyTypes` asks of every optional field here.
    expect('fault' in listed[0]!).toBe(false)
    expect(subnames(OwnerType.Pubkey, { url: 'x' }, prefix)).toEqual([])
  })
})
