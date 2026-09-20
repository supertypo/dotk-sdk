// The three ways a JavaScript program reaches a Kaspa node, each reduced to the one call this
// file makes. They differ in what a UTXO looks like on the way back. The wasm SDK hands back
// objects whose covenant id sits behind a getter, and `toJSON` drops it. wRPC's JSON has
// `covenantId: null` for a plain output. gRPC uses proto3, where an absent string is `""`.
//
// Any of them has to be a client that knows about covenant ids, which arrived with KIP-20 in
// the Toccata hard fork. `probe` refuses an older build.

import type { Node, NodeCallOptions, Utxo } from './node.js'

function text(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'string') return v
  // A wasm object spells itself through `toString`, and a number or a bigint spells its digits.
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v)
  if (typeof v !== 'object' || typeof (v as { toString?: unknown }).toString !== 'function') return undefined
  const spelled: unknown = (v as { toString(): unknown }).toString()
  return typeof spelled === 'string' ? spelled : undefined
}

/** A count the transport can spell as a number, a bigint or a decimal string. */
function count(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : typeof v === 'bigint' || typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** The outpoint and the DAA score, from whichever shape the transport gave them in. */
function where(
  outpoint: { transactionId?: unknown; index?: unknown } | undefined,
  daaScore: unknown
): Pick<Utxo, 'transactionId' | 'index' | 'daaScore'> {
  return { transactionId: text(outpoint?.transactionId), index: count(outpoint?.index), daaScore: count(daaScore) }
}

/** The objects `kaspa-wasm` returns from `getUtxosByAddresses`. */
export interface WasmUtxoEntryReference {
  address?: { toString(): string } | undefined
  outpoint?: { transactionId: string; index: number } | undefined
  entry?: { covenantId?: { toString(): string } | undefined; blockDaaScore?: bigint | number | undefined } | undefined
}

/**
 * The one call this file makes, as the wasm SDK's `RpcClient` declares it.
 *
 * The request is an object because `IGetUtxosByAddressesRequest` is one. The bindings coerce a
 * bare array too, but declaring that shape makes a client typed against the wasm SDK
 * unassignable here, and the same client has to serve `@dotk/sdk-tx`.
 */
export interface WasmRpcClient {
  getUtxosByAddresses(request: { addresses: string[] }): Promise<{ entries: WasmUtxoEntryReference[] }>
}

/**
 * A node behind the wasm SDK's `RpcClient`, already connected.
 *
 * Pass a function where the client is replaced over time, such as a browser extension that
 * tears its RPC down when idle. A captured reference to the old client waits forever on a
 * socket that nobody will answer.
 *
 * The covenant id reads as `entry.covenantId`, the only route to it. `UtxoEntryReference` has
 * no getter for it, and the object its `toString` builds leaves it out.
 */
export function fromWasm(client: WasmRpcClient | (() => WasmRpcClient)): Node {
  const rpc = typeof client === 'function' ? client : () => client
  return {
    async getUtxosByAddresses(addresses) {
      const { entries } = await rpc().getUtxosByAddresses({ addresses })
      return entries.map((e) => ({
        address: text(e.address)!,
        covenantId: text(e.entry?.covenantId),
        ...where(e.outpoint, e.entry?.blockDaaScore),
      }))
    },
  }
}

/** One wRPC (Borsh or JSON) response entry as JSON. */
export interface WrpcUtxoEntry {
  address?: string | null | undefined
  outpoint?: { transactionId: string; index: number } | undefined
  utxoEntry?: { covenantId?: string | null | undefined; blockDaaScore?: number | string | undefined } | undefined
}

/**
 * A node behind a JSON-RPC transport. `call(method, params)` answers the parsed result.
 *
 * The answer is `unknown` because that is what a correctly typed JSON-RPC client returns. A
 * narrower type for the one response shape rejects every such client and accepts only an
 * `any`-typed one.
 */
export function fromWrpcJson(
  call: (method: 'getUtxosByAddresses', params: { addresses: string[] }, options?: NodeCallOptions) => Promise<unknown>
): Node {
  return {
    async getUtxosByAddresses(addresses, options) {
      const { entries } = (await call('getUtxosByAddresses', { addresses }, options)) as {
        entries: WrpcUtxoEntry[]
      }
      return entries.map((e) => ({
        address: e.address!,
        covenantId: text(e.utxoEntry?.covenantId),
        ...where(e.outpoint, e.utxoEntry?.blockDaaScore),
      }))
    },
  }
}

/** One `RpcUtxosByAddressesEntry` as a gRPC client decodes it, in either field-name style. */
export interface GrpcUtxoEntry {
  address?: string | undefined
  outpoint?:
    { transactionId?: string | undefined; transaction_id?: string | undefined; index?: number | undefined } | undefined
  utxoEntry?:
    | {
        covenant_id?: string | undefined
        covenantId?: string | undefined
        blockDaaScore?: number | string | undefined
        block_daa_score?: number | string | undefined
      }
    | undefined
}

export interface GrpcUtxosResponse {
  entries?: GrpcUtxoEntry[] | undefined
  error?: { message?: string | undefined } | null | undefined
}

/**
 * A node behind gRPC. `call` sends one `GetUtxosByAddressesRequestMessage` and answers with the
 * matching response.
 *
 * kaspad's whole gRPC service is `rpc MessageStream (stream KaspadRequest) returns (stream
 * KaspadResponse)`, so there is no unary method and generated stubs have none. `call` puts a
 * request on that stream and waits for the response carrying `getUtxosByAddressesResponse`.
 * Both spellings of `covenant_id` are read, because loaders differ on whether they keep the
 * case of a field whose siblings are camelCase.
 */
export function fromGrpc(
  call: (request: { addresses: string[] }, options?: NodeCallOptions) => Promise<GrpcUtxosResponse>
): Node {
  return {
    async getUtxosByAddresses(addresses, options) {
      const response = await call({ addresses }, options)
      if (response.error?.message) throw new Error(response.error.message)
      return (response.entries ?? []).map((e): Utxo => ({
        address: e.address!,
        covenantId: text(e.utxoEntry?.covenant_id ?? e.utxoEntry?.covenantId),
        ...where(
          e.outpoint && {
            transactionId: e.outpoint.transactionId ?? e.outpoint.transaction_id,
            index: e.outpoint.index,
          },
          e.utxoEntry?.blockDaaScore ?? e.utxoEntry?.block_daa_score
        ),
      }))
    },
  }
}
