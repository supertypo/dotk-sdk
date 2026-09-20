import { describe, expect, it } from 'vitest'
import { toHex } from '../src/bytes.js'
import { LABEL_MAX, display, invalidReason, keyBytesOf, normalize, splitSubname, validateLabel } from '../src/names.js'
import { SubnameError } from '../src/errors.js'
import { feeForName } from '../src/manifest.js'
import { DEPLOYMENTS } from '../src/deployments.js'
import { vectors } from './vectors.js'

// The same registry the corpus was written from, as every other suite here reads it. A fee table
// is a deployment's own parameter, so reading one registry's manifest against another's corpus
// says nothing wherever the two tables differ.
const genesis = DEPLOYMENTS[vectors.manifest.network]!

describe('normalize', () => {
  it.each(vectors.normalize)('$input', ({ input, normalized, reason }) => {
    const got = normalize(input)
    expect(got).toBe(normalized)
    // The reason itself, not merely that there is one: this string reaches a person, and the
    // rules are tried in an order either implementation could get wrong on its own.
    expect(invalidReason(got) ?? null).toBe(reason)
  })
})

describe('display', () => {
  it.each(vectors.display)('$name', ({ name, display: shown }) => {
    expect(display(name)).toBe(shown)
  })
})

describe('keyBytesOf', () => {
  it.each(vectors.keyOf)('$name', ({ name, key }) => {
    expect(toHex(keyBytesOf(name))).toBe(key)
  })
})

// The fee table is a derivation this package exposes and `@dotk/sdk-tx` prices a registration
// with, and this is where the corpus reaches it: a change to it answers to these five scripts.
describe('feeForName', () => {
  it.each(vectors.feeForName)('$name', ({ name, fee }) => {
    expect(feeForName(genesis.params, name)).toBe(fee)
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

describe('validateLabel', () => {
  it('takes one or more segments, each of them a name', () => {
    for (const label of [
      'bob',
      'dev.team',
      'a',
      'a-b9',
      'x.y.z',
      'z'.repeat(32),
      'z'.repeat(32) + '.' + 'z'.repeat(31),
    ])
      expect(() => validateLabel(label), label).not.toThrow()
  })

  it('refuses a segment that is not a name, and names the fault', () => {
    // It normalizes nothing, so `Bob` is refused rather than folded. A stored key is then always
    // one a lookup reaches.
    for (const label of ['Bob', '', '-bob', 'bob-', 'a..b', '.bob', 'bob.', 'b ob', 'b_ob', '中', 'z'.repeat(33)])
      expect(
        tagOf(() => validateLabel(label)),
        label
      ).toBe('bad-label')
  })

  it('refuses the display suffix as a segment, wherever it sits', () => {
    for (const label of ['k', 'k.bob', 'bob.k', 'a.k.b'])
      expect(
        tagOf(() => validateLabel(label)),
        label
      ).toBe('bad-label')
  })

  /**
   * The cap is on the whole label rather than on a segment, so every case here holds segments
   * that pass on their own. A case with an over-long segment reaches the name rule first and
   * says nothing about this cap.
   */
  it('caps the whole label at LABEL_MAX bytes, dots included', () => {
    expect(LABEL_MAX).toBe(64)
    const fits = 'z'.repeat(32) + '.' + 'z'.repeat(31)
    const over = 'z'.repeat(32) + '.' + 'z'.repeat(32)
    const many = Array.from({ length: 10 }, () => 'zzzzzz').join('.')
    expect(fits).toHaveLength(LABEL_MAX)
    expect(over).toHaveLength(LABEL_MAX + 1)
    expect(many.length).toBeGreaterThan(LABEL_MAX)
    for (const label of [fits, over, many])
      for (const segment of label.split('.')) expect(() => validateLabel(segment)).not.toThrow()
    expect(() => validateLabel(fits)).not.toThrow()
    for (const label of [over, many]) {
      expect(
        tagOf(() => validateLabel(label)),
        label
      ).toBe('bad-label')
      // The payload is the whole label, because no one segment is what the cap refused.
      expect(() => validateLabel(label)).toThrow(JSON.stringify(label))
    }
  })
})

describe('splitSubname', () => {
  it('reads a bare name, with no label', () => {
    for (const [input, parent] of [
      ['alice', 'alice'],
      [' Alice ', 'alice'],
      ['alice.k', 'alice'],
      ['ALICE.K', 'alice'],
      // `k` is a registrable name, and it reads as itself in both spellings.
      ['k', 'k'],
      ['k.k', 'k'],
    ] as const) {
      expect(splitSubname(input), input).toEqual({ parent, label: null })
    }
  })

  it('splits at the last dot, under one stripped suffix', () => {
    expect(splitSubname('bob.alice.k')).toEqual({ parent: 'alice', label: 'bob' })
    expect(splitSubname(' Bob.Alice.K ')).toEqual({ parent: 'alice', label: 'bob' })
    expect(splitSubname('dev.team.alice.k')).toEqual({ parent: 'alice', label: 'dev.team' })
  })

  it('refuses a dotted input that does not end in the display suffix', () => {
    for (const input of ['bob.alice', 'pay.stripe.com', 'alice.kaspa'])
      expect(
        tagOf(() => splitSubname(input)),
        input
      ).toBe('no-suffix')
  })

  it('refuses a parent that is not a name, and the doubled suffix with it', () => {
    // Without this rule `alice.k.k` reads as the label `alice` under the parent `k`. That hands
    // the holder of `k` an answer for every doubled-suffix typo on the registry.
    for (const input of ['alice.k.k', 'bob.alice.k.k', '.k', '-a.k', 'a b.k'])
      expect(
        tagOf(() => splitSubname(input)),
        input
      ).toBe('bad-parent')
  })

  it('refuses a label the label rule refuses', () => {
    for (const input of ['k.alice.k', 'a..b.k', '-bob.alice.k', 'Bob..alice.k', `${'z'.repeat(65)}.alice.k`])
      expect(
        tagOf(() => splitSubname(input)),
        input
      ).toBe('bad-label')
  })
})
