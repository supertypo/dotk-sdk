import { type Address, Version, encodeAddress } from './bech32.js'
import { fromHex, equal } from './bytes.js'
import { ConfigError } from './errors.js'
import { blake2b256, templateHash } from './hash.js'

/** The compiled covenant as the deployment manifest publishes it. */
export interface CompiledArtifact {
  bytecode: number[]
  template_hash: number[]
  state_span: { offset: number; len: number }
}

/** A param-baked covenant template: fixed bytes around a state region that a client splices in. */
export class Template {
  private constructor(
    readonly bytecode: Uint8Array,
    readonly stateOffset: number,
    readonly stateLen: number
  ) {}

  /**
   * Build a template from its published artifact. Refuse it unless it reproduces the hash that
   * the package pins. The pin is what the covenants check each other against on-chain, so
   * bytecode that misses it derives addresses that hold nothing.
   */
  static fromArtifact(artifact: CompiledArtifact, pinnedHash: string, what: string): Template {
    const { offset, len } = artifact.state_span
    const bytecode = Uint8Array.from(artifact.bytecode)
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(len) ||
      offset < 0 ||
      len < 0 ||
      offset + len > bytecode.length
    ) {
      throw new ConfigError(`${what} template: state span lies outside its ${bytecode.length} bytes of bytecode`)
    }
    const template = new Template(bytecode, offset, len)
    if (!equal(template.hash(), fromHex(pinnedHash, `${what} template hash`))) {
      throw new ConfigError(`${what} template: bytecode does not reproduce the pinned template hash`)
    }
    return template
  }

  /** The fixed bytes before the state region. */
  prefix(): Uint8Array {
    return this.bytecode.subarray(0, this.stateOffset)
  }

  /** The fixed bytes after the state region. */
  suffix(): Uint8Array {
    return this.bytecode.subarray(this.stateOffset + this.stateLen)
  }

  hash(): Uint8Array {
    return templateHash(this.prefix(), this.suffix())
  }

  /** The redeem script with this state written over the state span. */
  redeem(state: Uint8Array): Uint8Array {
    if (state.length !== this.stateLen) throw new TypeError(`state must be ${this.stateLen} bytes, got ${state.length}`)
    const script = this.bytecode.slice()
    script.set(state, this.stateOffset)
    return script
  }

  /** The P2SH address that locks a state: blake2b-256 of the redeem script, as a script-hash address. */
  address(prefix: string, state: Uint8Array): Address & { text: string } {
    const payload = blake2b256(this.redeem(state))
    return { prefix, version: Version.ScriptHash, payload, text: encodeAddress(prefix, Version.ScriptHash, payload) }
  }

  /**
   * The locking script a state pays to: `OP_BLAKE2B <32-byte hash> OP_EQUAL`.
   *
   * The same commitment the address carries, in the form an output holds it. A spend needs this
   * script, and a read needs only the address.
   */
  scriptPublicKey(state: Uint8Array): Uint8Array {
    const hash = blake2b256(this.redeem(state))
    const spk = new Uint8Array(35)
    spk[0] = 0xaa // OP_BLAKE2B
    spk[1] = 0x20 // a 32-byte push
    spk.set(hash, 2)
    spk[34] = 0x87 // OP_EQUAL
    return spk
  }
}
