/**
 * The registries this package can address, and the manifest it judges each one's answers by.
 *
 * Every manifest is a static import, so an API can never supply the values a client checks that
 * same API against. A registry ships when this file lists it, and not when the generator leaves
 * a directory under `generated/`. To add one, run the generator and write two lines here. Until
 * somebody runs it for that network the import does not compile, which is the failure worth
 * having.
 */
import { ConfigError } from './errors.js'
import type { Manifest } from './manifest.js'
import mainnet from './generated/mainnet/genesis.js'
import testnet10 from './generated/testnet-10/genesis.js'

/**
 * Keyed by Kaspa network id, never by an address prefix. Every `testnet-*` shares one prefix, so
 * a prefix key makes two registries indistinguishable.
 */
export const DEPLOYMENTS: Readonly<Record<string, Manifest>> = {
  mainnet,
  'testnet-10': testnet10,
}

/**
 * The public directory for each registry, used unless a caller passes `api`.
 *
 * One per chain, because each registry has a service of its own. A shared default would point a
 * testnet client at mainnet's directory, whose answers this client refuses. `https://dotk.name`
 * is the web app and serves no API, so it is never a base here. The version segment is absent
 * because `Api` appends its own.
 */
export const DIRECTORIES: Readonly<Record<string, string>> = {
  mainnet: 'https://api.dotk.name',
  'testnet-10': 'https://api-tn10.dotk.name',
}

/**
 * Where to call for a network. A registry can ship without a public directory, such as a private
 * or local deployment, and for those a caller passes `api`, or `api: null` to work offline.
 */
export function directoryFor(network: string): string {
  const base = Object.hasOwn(DIRECTORIES, network) ? DIRECTORIES[network] : undefined
  if (!base) throw new ConfigError(`this package knows no directory for ${network}. Pass \`api\`, or \`api: null\``)
  return base
}

/** The networks {@link DEPLOYMENTS} covers, for a caller offering a choice between them. */
export const DEPLOYMENT_NETWORKS: readonly string[] = Object.keys(DEPLOYMENTS)

/**
 * The registry an unqualified client gets. Mainnet, because that is where a wrong guess costs
 * most, and named here rather than taken from the list's order.
 */
const PREFERRED = 'mainnet'

/**
 * The manifest for a network, or the default one.
 *
 * The default is mainnet where this build carries it, and otherwise the single registry it does
 * carry. With two registries and no mainnet among them, the caller has to name one.
 */
export function deploymentFor(network?: string): Manifest {
  if (network !== undefined) {
    const named = Object.hasOwn(DEPLOYMENTS, network) ? DEPLOYMENTS[network] : undefined
    if (!named)
      throw new ConfigError(`this package carries no registry on ${network}. It has ${DEPLOYMENT_NETWORKS.join(', ')}`)
    return named
  }

  const preferred = DEPLOYMENTS[PREFERRED]
  if (preferred) return preferred

  const sole = DEPLOYMENT_NETWORKS.length === 1 ? DEPLOYMENTS[DEPLOYMENT_NETWORKS[0]!] : undefined
  if (sole) return sole

  throw new ConfigError(`name a network: this package carries ${DEPLOYMENT_NETWORKS.join(', ')}`)
}
