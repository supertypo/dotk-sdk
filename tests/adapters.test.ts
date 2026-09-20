import { describe, expect, it } from 'vitest'
import { fromGrpc, fromWasm, fromWrpcJson } from '../src/adapters.js'
import { probe, PROBE_CHUNK } from '../src/node.js'
import type { Node } from '../src/node.js'

const COVENANT_ID = 'ab'.repeat(32)
const A = 'kaspa:a'
const B = 'kaspa:b'

describe('fromWasm', () => {
  it('reads the covenant id from behind the entry getter', async () => {
    const node = fromWasm({
      async getUtxosByAddresses() {
        return {
          entries: [
            { address: { toString: () => A }, entry: { covenantId: { toString: () => COVENANT_ID } } },
            { address: { toString: () => B }, entry: { covenantId: undefined } },
          ],
        }
      },
    })
    expect(await node.getUtxosByAddresses([A, B])).toEqual([
      { address: A, covenantId: COVENANT_ID },
      { address: B, covenantId: undefined },
    ])
  })

  /** A field that spells itself as anything but text is read as absent, never as text. */
  it('reads a covenant id that does not spell itself as text as absent', async () => {
    const node = fromWasm({
      async getUtxosByAddresses() {
        return {
          entries: [
            { address: { toString: () => A }, entry: { covenantId: { toString: () => 42 as unknown as string } } },
          ],
        }
      },
    })
    expect(await node.getUtxosByAddresses([A])).toEqual([{ address: A, covenantId: undefined }])
  })
})

describe('fromWrpcJson', () => {
  it('reads null as absent', async () => {
    const node = fromWrpcJson(async (method, params) => {
      expect(method).toBe('getUtxosByAddresses')
      expect(params).toEqual({ addresses: [A] })
      return {
        entries: [
          { address: A, utxoEntry: { covenantId: COVENANT_ID } },
          { address: A, utxoEntry: { covenantId: null } },
        ],
      }
    })
    expect(await node.getUtxosByAddresses([A])).toEqual([
      { address: A, covenantId: COVENANT_ID },
      { address: A, covenantId: undefined },
    ])
  })
})

describe('fromGrpc', () => {
  it('reads proto3 empty strings as absent, in either field style', async () => {
    const node = fromGrpc(async () => ({
      entries: [
        { address: A, utxoEntry: { covenant_id: COVENANT_ID } },
        { address: A, utxoEntry: { covenant_id: '' } },
        { address: B, utxoEntry: { covenantId: COVENANT_ID } },
      ],
    }))
    expect(await node.getUtxosByAddresses([A])).toEqual([
      { address: A, covenantId: COVENANT_ID },
      { address: A, covenantId: undefined },
      { address: B, covenantId: COVENANT_ID },
    ])
  })

  it('surfaces the response error', async () => {
    const node = fromGrpc(async () => ({ error: { message: 'utxoindex is not enabled' } }))
    await expect(node.getUtxosByAddresses([A])).rejects.toThrow(/utxoindex/)
  })
})

describe('probe', () => {
  it('asks in chunks and matches the covenant id case-insensitively', async () => {
    const asked: number[] = []
    const node: Node = {
      async getUtxosByAddresses(addresses) {
        asked.push(addresses.length)
        return addresses.slice(0, 1).map((address) => ({ address, covenantId: COVENANT_ID.toUpperCase() }))
      },
    }
    const addresses = Array.from({ length: PROBE_CHUNK + 1 }, (_, i) => `kaspa:${i}`)
    const found = await probe(node, addresses, COVENANT_ID)
    expect(asked).toEqual([PROBE_CHUNK, 1])
    expect([...found.keys()]).toEqual(['kaspa:0', `kaspa:${PROBE_CHUNK}`])
  })
})

describe('a client that is replaced under us', () => {
  it('is re-read on every call when one is passed as a function', async () => {
    const entries = (covenantId: string) => ({
      entries: [{ address: { toString: () => A }, entry: { covenantId: { toString: () => covenantId } } }],
    })
    let current = {
      async getUtxosByAddresses() {
        return entries(COVENANT_ID)
      },
    }
    const node = fromWasm(() => current)
    expect((await node.getUtxosByAddresses([A]))[0]!.covenantId).toBe(COVENANT_ID)
    current = {
      async getUtxosByAddresses() {
        return entries('cd'.repeat(32))
      },
    }
    expect((await node.getUtxosByAddresses([A]))[0]!.covenantId).toBe('cd'.repeat(32))
  })
})

describe('the caller signal', () => {
  it('reaches a transport that accepts one', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const wrpc = fromWrpcJson(async (_method, _params, options) => {
      seen.push(options?.signal)
      return { entries: [] }
    })
    const grpc = fromGrpc(async (_request, options) => {
      seen.push(options?.signal)
      return { entries: [] }
    })
    const signal = new AbortController().signal
    await wrpc.getUtxosByAddresses([A], { signal })
    await grpc.getUtxosByAddresses([A], { signal })
    expect(seen).toEqual([signal, signal])
  })
})

describe('a client blind to covenant ids', () => {
  it('is refused by probe rather than read as a registry that holds nothing', async () => {
    const blind: Node = { getUtxosByAddresses: async (addresses) => addresses.map((address) => ({ address })) }
    await expect(probe(blind, [A], COVENANT_ID)).rejects.toThrow(/no covenant id/)
  })

  it('is not suspected when the addresses simply hold nothing', async () => {
    const empty: Node = { getUtxosByAddresses: async () => [] }
    expect([...(await probe(empty, [A, B], COVENANT_ID)).keys()]).toEqual([])
  })

  it('is not suspected when at least one UTXO is attributed', async () => {
    const mixed: Node = {
      getUtxosByAddresses: async () => [{ address: A, covenantId: COVENANT_ID }, { address: B }],
    }
    expect([...(await probe(mixed, [A, B], COVENANT_ID)).keys()]).toEqual([A])
  })
})

describe('a transport that omits the address', () => {
  it('is refused by every adapter rather than filed under a placeholder', async () => {
    // An entry under an empty address matches no derived address, so it would read as a chain
    // refuting every name asked about, which is the one answer a mistake must not produce.
    const wasm = fromWasm({
      async getUtxosByAddresses() {
        return { entries: [{ entry: {} }] }
      },
    })
    await expect(probe(wasm, [A], COVENANT_ID)).rejects.toThrow(/without an address/)

    const wrpc = fromWrpcJson(async () => ({ entries: [{ utxoEntry: {} }] }))
    await expect(probe(wrpc, [A], COVENANT_ID)).rejects.toThrow(/without an address/)

    const grpc = fromGrpc(async () => ({ entries: [{ utxoEntry: {} }] }))
    await expect(probe(grpc, [A], COVENANT_ID)).rejects.toThrow(/without an address/)
  })
})
