import { type NetworkPrefix } from './bech32.js'
import { ConfigError } from './errors.js'
import { type CompiledArtifact, Template } from './template.js'

/** A parameter type, as the ABI artifact spells it. */
export type AbiType =
  | { kind: 'int' | 'temporal' | 'bool' | 'byte' | 'bytes' | 'text' | 'pubkey' | 'sig' | 'datasig' }
  | { kind: 'fixed_bytes'; len: number }
  | { kind: 'fixed_array'; item: AbiType; len: number }
  | { kind: 'dynamic_array'; item: AbiType }
  | { kind: 'struct'; name: string }

/**
 * One entrypoint as the deployment declares it. `dispatch_tag` is
 * `blake3("name(argtypes)")[0:4]`, frozen with the templates, because an entrypoint's name and
 * argument types are part of what a deployed UTXO's spend path commits to. This package reads it
 * from here and never recomputes it.
 */
export interface AbiEntry {
  dispatch_tag: string
  params: { name: string; type: AbiType }[]
}

/** One covenant's ABI: its entrypoints and the bytecode they are spent against. */
export interface AbiContract {
  entries: Record<string, AbiEntry>
  compiled: CompiledArtifact
}

/**
 * The same artifact as the generated manifest module types it. The generator writes a plain
 * object literal, so `kind` infers as `string` and {@link AbiType} cannot describe it.
 * `loadRegistry` narrows it once.
 */
export interface AbiArtifact {
  entries: Record<string, { dispatch_tag: string; params: { name: string; type: { kind: string } }[] }>
  compiled: CompiledArtifact
}

/**
 * The deployment's economic constants, in sompi, as the covenants were compiled with them.
 *
 * The compiler bakes these into the template bytes, so a deployment with different values is a
 * different registry with different template hashes. The `fee_*` fields are the registration fee
 * by the name's byte length.
 */
export interface Params {
  devfund_spk: string
  fee_1ch: number
  fee_2ch: number
  fee_3ch: number
  fee_4ch: number
  fee_5plus: number
  bond: number
  deposit: number
  gap_value: number
  /** The eviction window: how long the covenant protects a PENDING deed before anyone can evict it, in DAA. */
  t_evict: number
}

/**
 * The subset of a deployment manifest (`genesis.json`) a client needs. It holds the
 * registry's identity, its economic constants and the two covenant templates, each pinned by
 * its hash.
 */
export interface Manifest {
  /** The manifest's shape. {@link MANIFEST_VERSIONS} are the ones this package reads. */
  version: number
  network: string
  registryCovenantId: string
  gapTemplateHash: string
  deedTemplateHash: string
  params: Params
  gapAbi: { contracts: { DotkGap: AbiArtifact } }
  deedAbi: { contracts: { DotkDeed: AbiArtifact } }
}

/** A registry as a client works with it. `prefix` is the bech32 address prefix of its network. */
export interface Registry {
  network: string
  prefix: string
  registryCovenantId: string
  params: Params
  deed: Template
  gap: Template
  /** The deed covenant's entrypoints, for a client building a spend of one. */
  deedAbi: AbiContract
  /** The gap covenant's entrypoints, for the same reason. */
  gapAbi: AbiContract
}

/** The bech32 prefix of a Kaspa network id, as a node or a manifest names the network. */
export function prefixFor(network: string): NetworkPrefix {
  if (network === 'mainnet') return 'kaspa'
  if (network === 'testnet' || network.startsWith('testnet-')) return 'kaspatest'
  if (network === 'simnet') return 'kaspasim'
  if (network === 'devnet') return 'kaspadev'
  throw new ConfigError(`unknown network ${network}`)
}

/** The registration fee for a name, by its length in bytes on the chain. */
export function feeForName(params: Params, name: string): number {
  const bytes = new TextEncoder().encode(name).length
  if (bytes <= 1) return params.fee_1ch
  if (bytes === 2) return params.fee_2ch
  if (bytes === 3) return params.fee_3ch
  if (bytes === 4) return params.fee_4ch
  return params.fee_5plus
}

/**
 * The manifest shape this package writes its bundled deployments in.
 *
 * `DotkOptions.genesis` lets a caller hand in another deployment's manifest, so this
 * package checks the shape a manifest declares. A document written to a later shape otherwise
 * parses as far as it happens to, and derives a wrong address instead of refusing.
 */
export const MANIFEST_VERSION = 6

/**
 * The shapes this package reads. Versions 5 and 6 only change `genesisBinding`, the covenant id's
 * spelled-out preimage and then the outpoint's spelling. Nothing here consults that field, so all
 * three describe the same registry.
 */
export const MANIFEST_VERSIONS: readonly number[] = [4, 5, 6]

export function loadRegistry(manifest: Manifest): Registry {
  // A manifest a caller hands in can miss any part, and a missing one must be a refusal rather
  // than a crash, because a crash names no cause. The reads below assume nothing the type says.
  const given = manifest as {
    params?: { bond?: unknown } | undefined
    network?: unknown
    deedAbi?: { contracts?: { DotkDeed?: { compiled?: unknown } | undefined } | undefined } | undefined
    gapAbi?: { contracts?: { DotkGap?: { compiled?: unknown } | undefined } | undefined } | undefined
    deedTemplateHash?: unknown
    gapTemplateHash?: unknown
  }
  if (!MANIFEST_VERSIONS.includes(manifest.version))
    throw new ConfigError(
      `this package reads manifest versions ${MANIFEST_VERSIONS.join(', ')}, and the one it was given is ${manifest.version}`
    )
  if (!/^[0-9a-f]{64}$/.test(manifest.registryCovenantId))
    throw new ConfigError('the manifest carries no registry covenant id')
  if (typeof given.params?.bond !== 'number') throw new ConfigError('the manifest carries no deployment params')
  if (typeof given.network !== 'string' || given.network.length === 0)
    throw new ConfigError('the manifest names no network')
  const deed = given.deedAbi?.contracts?.DotkDeed
  const gap = given.gapAbi?.contracts?.DotkGap
  if (!deed?.compiled || !gap?.compiled)
    throw new ConfigError('the manifest carries no compiled deed and gap templates')
  const hash = /^[0-9a-f]{64}$/i
  if (
    typeof given.deedTemplateHash !== 'string' ||
    typeof given.gapTemplateHash !== 'string' ||
    !hash.test(given.deedTemplateHash) ||
    !hash.test(given.gapTemplateHash)
  )
    throw new ConfigError('the manifest carries no template hashes')
  // A template that does not load is refused by name too, whatever the loader threw.
  const template = (load: () => Template, which: string): Template => {
    try {
      return load()
    } catch (e) {
      throw new ConfigError(
        `the manifest's ${which} template does not load: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      )
    }
  }
  return {
    network: manifest.network,
    prefix: prefixFor(manifest.network),
    registryCovenantId: manifest.registryCovenantId,
    params: manifest.params,
    deed: template(
      () => Template.fromArtifact(manifest.deedAbi.contracts.DotkDeed.compiled, manifest.deedTemplateHash, 'deed'),
      'deed'
    ),
    gap: template(
      () => Template.fromArtifact(manifest.gapAbi.contracts.DotkGap.compiled, manifest.gapTemplateHash, 'gap'),
      'gap'
    ),
    deedAbi: manifest.deedAbi.contracts.DotkDeed as unknown as AbiContract,
    gapAbi: manifest.gapAbi.contracts.DotkGap as unknown as AbiContract,
  }
}
