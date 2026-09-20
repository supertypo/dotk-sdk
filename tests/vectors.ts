// The conformance corpus the parent workspace's generator writes from the same manifest the
// package bundles, one per registry the package can address. It is committed here, so a clone of
// this repository alone replays it.
import { DEPLOYMENTS, DEPLOYMENT_NETWORKS } from '../src/deployments.js'
import mainnet from '../src/generated/mainnet/vectors.json' with { type: 'json' }
import testnet10 from '../src/generated/testnet-10/vectors.json' with { type: 'json' }

export interface Vectors {
  manifest: { network: string; registryCovenantId: string }
  normalize: { input: string; normalized: string; reason: string | null }[]
  display: { name: string; display: string }[]
  keyOf: { name: string; key: string }[]
  owner: { network: string; ownerType: number; owner: string; address: string | null }[]
  deedAddress: { network: string; name: string; ownerType: number; owner: string; state: string; address: string }[]
  gapAddress: { network: string; lo: string; hi: string; state: string; address: string }[]
  feeForName: { name: string; fee: number }[]
  card: {
    network: string
    name: string
    records: Record<string, string | boolean | { opaque: string }>
    blob: string
    recordsHash: string
    spenderType: number
    spender: string
    state: string
    redeemScript: string
    spk: string
    address: string
    sweepSigScript: string
    payload: string
  }[]
  recordsDecode: {
    what: string
    blob: string
    records?: Record<string, string | boolean | { opaque: string }>
    reencoded?: string
    fault?: string
  }[]
  /**
   * One subname lookup, the three subname rules end to end.
   *
   * A row takes one of three shapes. Where `parent` and `label` are both absent, rule 1 refused
   * the input, and a replay must not call `subnameOf` at all. Where `label` alone is absent, the
   * input is a bare name. Where a row carries a label and neither `address` nor `fault`, the
   * parent's card holds no such key, which is the `no-such-label` answer this package tags
   * itself.
   *
   * A field this interface marks optional is absent from the JSON, never null. A field that can
   * be empty and is not optional carries a null instead, as `reason` and `address` do above.
   */
  subname: {
    network: string
    input: string
    ownerType: number
    parent?: string
    label?: string
    records: Record<string, string | boolean | { opaque: string }>
    address?: string
    fault?: string
  }[]
  /**
   * Every `sub:` entry of one card, with its verdict. `entries` is in key order, bytewise.
   *
   * A replay decodes `blob` and lists from what it reads. The decoder answers in the blob's own
   * order, which is the shortest key first, so the replay has to sort by key bytes to reach
   * `entries`. `records` is the same set for a reader that decodes nothing, and its JSON object
   * already carries the order of `entries`.
   */
  subnameList: {
    network: string
    ownerType: number
    records: Record<string, string | boolean | { opaque: string }>
    blob: string
    entries: { label: string; address?: string; fault?: string }[]
  }[]
  subnameValue: { ownerType: number; owner: string; value?: { opaque: string }; fault?: string }[]
}

/**
 * One corpus per bundled registry, keyed the way `DEPLOYMENTS` is.
 *
 * Listed by hand for the same reason the deployments are, and checked against that list in
 * `deployments.test.ts`: a registry bundled without its corpus would ship derivations nothing
 * replays, which is the whole of what these tests prove.
 */
export const CORPORA: Readonly<Record<string, Vectors>> = {
  mainnet,
  'testnet-10': testnet10,
}

/**
 * The corpus the per-derivation suites read.
 *
 * They replay one registry's, because what they hold to account is the TypeScript against the
 * reference implementation, and neither side varies by deployment. The templates an address derives through do vary,
 * and `deployments.test.ts` loops over every bundled registry for that.
 */
export const vectors = CORPORA[DEPLOYMENT_NETWORKS[0]!]!

for (const network of DEPLOYMENT_NETWORKS) {
  const corpus = CORPORA[network]
  if (!corpus) continue
  if (corpus.manifest.registryCovenantId !== DEPLOYMENTS[network]!.registryCovenantId) {
    throw new Error(
      `${network}: vectors.json was written from another manifest than genesis.ts; rerun the generator in the parent workspace`
    )
  }
}
