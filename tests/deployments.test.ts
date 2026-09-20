import { describe, expect, it } from 'vitest'
import { Dotk } from '../src/dotk.js'
import { DEPLOYMENTS, DEPLOYMENT_NETWORKS, deploymentFor } from '../src/deployments.js'
import { ConfigError } from '../src/errors.js'
import { fromHex, toHex } from '../src/bytes.js'
import { loadRegistry, prefixFor } from '../src/manifest.js'
import { keyBytesOf, paddedName } from '../src/names.js'
import { encodeActiveDeedState, encodeGapState } from '../src/state.js'
import { CORPORA } from './vectors.js'

/**
 * What the per-derivation suites cannot see.
 *
 * They replay one registry, because the code they hold to account does not vary by deployment.
 * The templates an address is derived through do vary: they carry the deployment's parameters
 * baked into their bytecode, so a second registry is a second set of P2SH addresses that nothing
 * else here would ever compute. This is where every bundled one is exercised.
 */
describe('every bundled registry', () => {
  it('carries at least one', () => {
    expect(DEPLOYMENT_NETWORKS.length).toBeGreaterThan(0)
  })

  // A registry bundled without its corpus ships derivations nothing replays, and the loops below
  // would pass by iterating over nothing.
  it('has a corpus, and no corpus belongs to a registry that is not bundled', () => {
    expect(Object.keys(CORPORA).sort()).toEqual([...DEPLOYMENT_NETWORKS].sort())
  })

  it.each(DEPLOYMENT_NETWORKS)('%s is filed under the network its manifest declares', (network) => {
    expect(DEPLOYMENTS[network]!.network).toBe(network)
    expect(CORPORA[network]!.manifest.network).toBe(network)
  })

  // The corpus names the manifest it was computed from, so this is what catches a manifest
  // refreshed without its corpus, or a corpus copied from another deployment.
  it.each(DEPLOYMENT_NETWORKS)('%s replays the corpus written from its own manifest', (network) => {
    expect(CORPORA[network]!.manifest.registryCovenantId).toBe(DEPLOYMENTS[network]!.registryCovenantId)
  })

  it.each(DEPLOYMENT_NETWORKS)('%s derives every deed and gap address its corpus pins', (network) => {
    const registry = loadRegistry(DEPLOYMENTS[network]!)
    const corpus = CORPORA[network]!

    // An empty section would pass by iterating over nothing, which is the one failure this guards.
    expect(corpus.deedAddress.length).toBeGreaterThan(0)
    expect(corpus.gapAddress.length).toBeGreaterThan(0)
    for (const { network: net, name, ownerType, owner, state, address } of corpus.deedAddress) {
      const encoded = encodeActiveDeedState(keyBytesOf(name), ownerType, fromHex(owner), paddedName(name))
      expect(toHex(encoded)).toBe(state)
      expect(registry.deed.address(prefixFor(net), encoded).text).toBe(address)
    }

    for (const { network: net, lo, hi, state, address } of corpus.gapAddress) {
      const encoded = encodeGapState(fromHex(lo), fromHex(hi))
      expect(toHex(encoded)).toBe(state)
      expect(registry.gap.address(prefixFor(net), encoded).text).toBe(address)
    }
  })

  it.each(DEPLOYMENT_NETWORKS)('%s is what a client naming it addresses', (network) => {
    const dotk = new Dotk({ network, api: null })
    expect(dotk.network).toBe(network)
    expect(dotk.registryCovenantId).toBe(DEPLOYMENTS[network]!.registryCovenantId)
  })
})

describe('choosing between them', () => {
  // The message names what there is, because the caller who reaches it holds a network id this
  // build cannot serve and has no other way to learn which it can.
  it('refuses a network it carries no registry for, and says which it has', () => {
    expect(() => deploymentFor('nosuchnet')).toThrow(ConfigError)
    expect(() => deploymentFor('nosuchnet')).toThrow(new RegExp(DEPLOYMENT_NETWORKS.join(', ')))
    expect(() => new Dotk({ network: 'nosuchnet' })).toThrow(ConfigError)
  })

  it('gives an unqualified client mainnet where that is bundled, and otherwise the only registry there is', () => {
    const expected = DEPLOYMENT_NETWORKS.includes('mainnet')
      ? 'mainnet'
      : DEPLOYMENT_NETWORKS.length === 1
        ? DEPLOYMENT_NETWORKS[0]
        : null

    if (expected === null) {
      expect(() => deploymentFor()).toThrow(ConfigError)
    } else {
      expect(deploymentFor().network).toBe(expected)
      expect(new Dotk({ api: null }).network).toBe(expected)
    }
  })

  // The escape hatch stays an escape hatch: a manifest passed in is used as given, and naming a
  // network beside it that the manifest does not declare is a contradiction rather than a choice.
  /** A name off `Object.prototype` is no network. */
  it('refuses a prototype property as a network name', () => {
    for (const network of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => deploymentFor(network), network).toThrow(ConfigError)
      expect(() => new Dotk({ api: null, network }), network).toThrow(ConfigError)
    }
  })

  it('takes a manifest it does not carry, and refuses one contradicted by the network beside it', () => {
    const carried = DEPLOYMENTS[DEPLOYMENT_NETWORKS[0]!]!
    expect(new Dotk({ genesis: carried, api: null }).registryCovenantId).toBe(carried.registryCovenantId)
    expect(() => new Dotk({ genesis: carried, network: 'simnet', api: null })).toThrow(ConfigError)
  })
})
