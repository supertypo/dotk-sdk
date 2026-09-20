import { NodeError } from './errors.js'

/** One UTXO as this package needs to see it: where it sits, and which covenant minted it. */
export interface Utxo {
  /**
   * Where the output sits. {@link scan} keys its map by this and refuses a UTXO without one. An
   * adapter asserts the address instead of substituting a placeholder, because an entry filed
   * under an empty address matches no derived address and reads as a chain that refutes the name.
   */
  address: string
  /**
   * The KIP-20 covenant id, when the output carries one. The type accepts `null` as well as
   * `undefined`, because wRPC JSON spells an absent one as `null`, so an adapter that passes the
   * node's answer through does not have to normalize it.
   */
  covenantId?: string | null | undefined
  /**
   * The outpoint, which is what the card rules judge a card by. The bundled adapters fill it. A
   * node that leaves it out still resolves names, and this package refuses it only where a card
   * has to be proven.
   */
  transactionId?: string | undefined
  index?: number | undefined
  /** The DAA score of the block that accepted the output, which orders competing `primary` claims. */
  daaScore?: number | undefined
}

export interface NodeCallOptions {
  signal?: AbortSignal | undefined
}

/**
 * What a client asks of a Kaspa node: the UTXOs at a list of addresses, from a node running with
 * `--utxoindex`. Wrap a real client with `fromWasm`, `fromWrpcJson` or
 * `fromGrpc`, or hand in anything with this shape.
 *
 * The second argument is optional on both sides. An implementation that ignores it satisfies
 * this interface, and one that honors it lets a caller's `signal` reach the transport.
 */
export interface Node {
  getUtxosByAddresses(addresses: string[], options?: NodeCallOptions): Promise<Utxo[]>
}

/**
 * Addresses per request. A node answers a batch one address at a time and holds its utxoindex
 * read lock for the whole call. A wide chunk therefore saves round trips and costs that node's
 * index updates for as long as the call runs. 400 is the widest this project has evidence for.
 */
export const PROBE_CHUNK = 400

/**
 * Every UTXO at each of the addresses, keyed by address. One request per chunk, so a scan of
 * many addresses does not grow past what a node answers.
 */
export async function scan(node: Node, addresses: string[], signal?: AbortSignal): Promise<Map<string, Utxo[]>> {
  const found = new Map<string, Utxo[]>()
  for (let at = 0; at < addresses.length; at += PROBE_CHUNK) {
    signal?.throwIfAborted()
    let utxos: Utxo[]
    try {
      utxos = await node.getUtxosByAddresses(addresses.slice(at, at + PROBE_CHUNK), { signal })
    } catch (e) {
      throw new NodeError(`this package failed to ask the node: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
    for (const u of utxos) {
      if (typeof u.address !== 'string') throw new NodeError('the node returned a UTXO without an address')
      const list = found.get(u.address)
      if (list) list.push(u)
      else found.set(u.address, [u])
    }
  }
  return found
}

/**
 * Which of the addresses hold a UTXO of this registry, and the UTXO each holds.
 *
 * Every address here derives from the registry's own templates, so a UTXO at one was minted by a
 * covenant and carries a covenant id. A client that reports none has a build older than KIP-20.
 * Taken at face value its silence answers "not held" for the whole registry, so this package
 * refuses such a client.
 */
export async function probe(
  node: Node,
  addresses: string[],
  registryCovenantId: string,
  signal?: AbortSignal
): Promise<Map<string, Utxo>> {
  return attribute(await scan(node, addresses, signal), addresses, registryCovenantId)
}

/**
 * {@link probe}'s judgment over a scan already made, so a caller needing UTXOs at two sets of
 * addresses asks for both in one request.
 *
 * This function judges only `addresses`. A card sits at a plain P2SH and carries no covenant id,
 * so counting one fires the refusal below on a registry that is merely quiet.
 */
export function attribute(
  scanned: Map<string, Utxo[]>,
  addresses: string[],
  registryCovenantId: string
): Map<string, Utxo> {
  const found = new Map<string, Utxo>()
  const want = registryCovenantId.toLowerCase()
  let seen = 0
  let attributed = 0
  for (const address of addresses) {
    for (const u of scanned.get(address) ?? []) {
      seen += 1
      if (u.covenantId !== undefined && u.covenantId !== null) attributed += 1
      if (u.covenantId?.toLowerCase() === want && !found.has(u.address)) found.set(u.address, u)
    }
  }
  if (seen > 0 && attributed === 0) {
    throw new NodeError(
      'the node client reports no covenant id on any UTXO of this registry, so nothing can be proven through it. ' +
        'Covenant ids arrived with KIP-20 in the Toccata hard fork: use a client built against a node release ' +
        'that carries them.'
    )
  }
  return found
}
