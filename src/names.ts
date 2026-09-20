import { utf8 } from './bytes.js'
import { InvalidNameError, SubnameError } from './errors.js'
import { blake3 } from './hash.js'

export const MAX_NAME_LEN = 32
/** The display suffix. It is a convention of readers, and the chain stores bare names. */
export const DISPLAY_SUFFIX = '.k'

// Rust's `str::trim` removes every Unicode White_Space character. A JS `String.prototype.trim`
// removes a different set, because it leaves U+0085 and strips U+FEFF. This file spells the trim
// out to keep both sides byte-identical.
// An index scan, as Rust's `str::trim` is. An end-anchored regex retries a greedy match from
// every position of an interior whitespace run, which is quadratic in the run's length.
const WHITE_SPACE = /\p{White_Space}/u
function trim(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && WHITE_SPACE.test(s[a]!)) a++
  while (b > a && WHITE_SPACE.test(s[b - 1]!)) b--
  return s.slice(a, b)
}

// Rust's `to_ascii_lowercase` leaves every non-ASCII code point alone. A JS `toLowerCase()`
// case-folds such a code point, so this function touches only a-z.
function asciiLowercase(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function stripSuffix(s: string, suffix: string): string | undefined {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : undefined
}

/**
 * The canonical on-chain spelling of what a user typed: trimmed, ASCII lowercased and the `.k`
 * suffix dropped. The lowercase step runs first, so the suffix step strips a typed `.K` too.
 * This is a spelling transform only, and it proves nothing about validity. Run [`validate`] on
 * the result. Non-ASCII input arrives there unchanged and fails on the charset rule.
 */
export function normalize(input: string): string {
  const s = asciiLowercase(trim(input))
  return stripSuffix(s, DISPLAY_SUFFIX) ?? s
}

/** Why a bare name is not one the covenant accepts, or undefined when it is. */
export function invalidReason(name: string): string | undefined {
  const b = utf8.encode(name)
  // The charset rule runs before the length rule, as it does in Rust. For input that the charset
  // can never hold, this function gives the charset reason at any size. The other order sends a
  // user off to shorten a name that no length makes legal.
  if (!/^[a-z0-9-]*$/.test(name)) return 'allowed characters: a-z, 0-9 and hyphen'
  if (b.length === 0 || b.length > MAX_NAME_LEN) return `name must be 1..=${MAX_NAME_LEN} bytes on-chain`
  if (name.startsWith('-') || name.endsWith('-')) return 'name cannot start or end with a hyphen'
  return undefined
}

/** The covenant's policy: 1 to 32 bytes of a-z, 0-9 and hyphen, no hyphen at either end. */
export function validate(name: string): void {
  const reason = invalidReason(name)
  if (reason !== undefined) throw new InvalidNameError(reason)
}

/** A bare name as readers show it: its own bytes with the display suffix appended. */
export function display(name: string): string {
  return name + DISPLAY_SUFFIX
}

/** The name key as bytes, blake3 of the bare name. The registry is partitioned over these. `Dotk.keyOf` is the same key as hex. */
export function keyBytesOf(name: string): Uint8Array {
  return blake3(utf8.encode(name))
}

/**
 * The claim a registration publishes at `split`: `blake3(name ‖ ownerType ‖ owner)`.
 *
 * Only the party who chose the owner can satisfy it, which makes a registration hash-blind and
 * theft-proof. The scheme byte is inside the commitment, so the claim fully determines the deed
 * that its reveal mints.
 */
export function claimOf(name: string, ownerType: number, owner: Uint8Array): Uint8Array {
  if (owner.length !== 32) throw new TypeError(`owner must be 32 bytes, got ${owner.length}`)
  const bare = utf8.encode(name)
  const buf = new Uint8Array(bare.length + 33)
  buf.set(bare)
  buf[bare.length] = ownerType
  buf.set(owner, bare.length + 1)
  return blake3(buf)
}

/** The deed's name field: the bare name zero-padded to 32 bytes. */
export function paddedName(name: string): Uint8Array {
  validate(name)
  const out = new Uint8Array(MAX_NAME_LEN)
  out.set(utf8.encode(name))
  return out
}

// ---- subnames ------------------------------------------------------------------------------

/**
 * The most bytes a subname label can hold, dots included. The record key that carries it is
 * `SUBNAME_PREFIX` plus at most this.
 */
export const LABEL_MAX = 64

/**
 * {@link DISPLAY_SUFFIX} without its dot: the one segment no label can hold, and the one name no
 * parent under a label can be. Derived, so the two cannot drift apart.
 */
const SUFFIX_SEGMENT = DISPLAY_SUFFIX.startsWith('.') ? DISPLAY_SUFFIX.slice(1) : DISPLAY_SUFFIX

function badParent(parent: string): SubnameError {
  const why = parent === '' ? 'the parent is empty' : `the parent ${JSON.stringify(parent)} cannot carry a subname`
  return new SubnameError(why, 'bad-parent')
}

function badLabel(part: string): SubnameError {
  const why = part === '' ? 'the label is empty' : `the label part ${JSON.stringify(part)} breaks the label rule`
  return new SubnameError(why, 'bad-label')
}

/** The parent of a subname is a name, and a name that is not one names nothing. */
function requireParent(parent: string): void {
  if (invalidReason(parent) !== undefined) throw badParent(parent)
}

/**
 * The label rule. A label is one or more dot-separated segments, each of them a name and none of
 * them the display suffix. The whole label holds at most {@link LABEL_MAX} bytes.
 *
 * It normalizes nothing, so it refuses `Bob`. A stored key is therefore always one a lookup can
 * reach.
 */
export function validateLabel(label: string): void {
  if (label === '') throw badLabel('')
  // The cap is on the bytes a record key carries, so it counts UTF-8 rather than code units.
  // The length rule runs before the charset rule here, as it does in Rust.
  if (utf8.encode(label).length > LABEL_MAX) throw badLabel(label)
  for (const segment of label.split('.')) {
    if (invalidReason(segment) !== undefined) throw badLabel(segment)
    if (segment === SUFFIX_SEGMENT) throw badLabel(segment)
  }
}

/**
 * Rule 1 of the subname rules: the parent and the optional label a typed input names. It throws
 * {@link SubnameError} for an input that names neither.
 *
 * Trim and lowercase first, so `Bob.alice.k` reads as `bob.alice.k`. Without a dot the input is
 * a bare name, and `label` is null. With a dot it must end in {@link DISPLAY_SUFFIX}, which this
 * function strips once. The last dot of what remains divides the label from the parent.
 *
 * The parent cannot be the suffix segment under a label. Without that rule `alice.k.k` reads as
 * the label `alice` under the parent `k`, whose holder then answers every doubled-suffix typo.
 */
export function splitSubname(input: string): { parent: string; label: string | null } {
  const s = asciiLowercase(trim(input))
  if (!s.includes('.')) {
    requireParent(s)
    return { parent: s, label: null }
  }
  const body = stripSuffix(s, DISPLAY_SUFFIX)
  if (body === undefined) throw new SubnameError(`a dotted input must end in ${DISPLAY_SUFFIX}`, 'no-suffix')
  const at = body.lastIndexOf('.')
  if (at === -1) {
    requireParent(body)
    return { parent: body, label: null }
  }
  const label = body.slice(0, at)
  const parent = body.slice(at + 1)
  requireParent(parent)
  if (parent === SUFFIX_SEGMENT) throw badParent(parent)
  validateLabel(label)
  return { parent, label }
}
