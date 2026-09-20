import { describe, expect, it, vi } from 'vitest'
import { Dotk, displayOrder } from '../src/dotk.js'
import { withDeadline, yieldNow } from '../src/deadline.js'
import { DEED_STATE_LEN, GAP_STATE_LEN } from '../src/state.js'
import { feeForName } from '../src/manifest.js'
import { DEPLOYMENTS, DIRECTORIES, directoryFor } from '../src/deployments.js'
import {
  ApiError,
  ConfigError,
  DotkError,
  InvalidAddressError,
  InvalidNameError,
  NodeError,
  RefutedError,
  RegistryMismatchError,
  SubnameError,
  TimeoutError,
} from '../src/errors.js'
import { Api, API_VERSION_PATH, MAX_BODY_BYTES, MAX_LIST_ITEMS, type CardOut } from '../src/api.js'
import { CARD_VALUE, cardAddress, cardState, encodeRecords, recordsOf, type Records } from '../src/cards.js'
import { decodeAddress, encodeAddress, Version } from '../src/bech32.js'
import { schnorr as secp } from '@noble/curves/secp256k1.js'
import { ownerAddress } from '../src/owner.js'
import { keyBytesOf } from '../src/names.js'
import type { Node, Utxo } from '../src/node.js'
import { hex32, toHex } from '../src/bytes.js'
import { vectors } from './vectors.js'

// The registry the corpus was written from: the one an unqualified client gets.
const genesis = DEPLOYMENTS[vectors.manifest.network]!
const COVENANT_ID = genesis.registryCovenantId
const NET = genesis.network
const schnorr = vectors.owner.find((v) => v.network === NET && v.ownerType === 0)!
const ecdsa = vectors.owner.find((v) => v.network === NET && v.ownerType === 0x85)!
const covenantOwner = vectors.owner.find((v) => v.network === NET && v.ownerType === 4)!
const deedOf = (name: string, ownerType: number) =>
  vectors.deedAddress.find((v) => v.network === NET && v.name === name && v.ownerType === ownerType)!
const gapOf = (lo: string) => vectors.gapAddress.find((v) => v.lo === lo)!
const otherPrefix = vectors.owner.find((v) => v.network !== NET && v.address !== null)!.address!

type Route = (url: string) => { status: number; body?: unknown } | undefined

/** A `fetch` that answers from a table, and records what it was asked. */
function fakeFetch(route: Route) {
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const answer = route(url)
    if (!answer) return new Response('nope', { status: 404 })
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

/** A node holding UTXOs at these addresses, with these covenant ids. */
function fakeNode(held: Utxo[]): Node & { asked: string[][] } {
  const asked: string[][] = []
  return {
    asked,
    async getUtxosByAddresses(addresses) {
      asked.push(addresses)
      return held.filter((u) => addresses.includes(u.address))
    },
  }
}

const nameBody = (name: string, ownerType: number, owner: string, address?: string) => ({
  name,
  ownerType,
  owner,
  ...(address ? { address } : { ownerCovenantId: owner }),
  deedAddress: 'kaspatest:not-trusted',
  registryCovenantId: COVENANT_ID,
})

describe('construction', () => {
  /** The registry a client works with, which the write half builds on: the network, its prefix, the covenant id and both templates. */
  it('exposes the registry it was built with as protocol', () => {
    const dotk = new Dotk({ api: null })
    const registry = dotk.protocol
    expect(registry.network).toBe(NET)
    expect(registry.registryCovenantId).toBe(COVENANT_ID)
    expect(registry.prefix).toBe(dotk.prefix)
    expect(registry.params).toBe(dotk.params)
    expect(registry.deed.stateLen).toBe(DEED_STATE_LEN)
    expect(registry.gap.stateLen).toBe(GAP_STATE_LEN)
  })

  /** A deadline is a positive number of milliseconds or null. A zero or a NaN deadline fires at once or never. */
  it('refuses a deadline that is not a positive number of milliseconds', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Dotk({ api: null, timeoutMs }), String(timeoutMs)).toThrow(ConfigError)
      expect(
        () => new Api({ base: 'http://x', registryCovenantId: COVENANT_ID, timeoutMs }),
        String(timeoutMs)
      ).toThrow(ConfigError)
    }
    expect(new Dotk({ api: null, timeoutMs: null }).network).toBe(NET)
    expect(new Dotk({ api: null, timeoutMs: 1 }).network).toBe(NET)
  })

  /** A manifest a caller hands in that misses a part is refused by name, never a crash out of a dereference. */
  it('refuses a manifest that misses its templates, its hashes or its network, as a configuration error', () => {
    const whole = DEPLOYMENTS[NET]!
    const without = (edit: (m: Record<string, unknown>) => void) => {
      const copy = structuredClone(whole) as unknown as Record<string, unknown>
      edit(copy)
      return () => new Dotk({ api: null, genesis: copy as unknown as typeof whole })
    }
    expect(without((m) => delete m['deedAbi'])).toThrow(ConfigError)
    expect(without((m) => ((m['gapAbi'] as Record<string, unknown>)['contracts'] = {}))).toThrow(ConfigError)
    expect(without((m) => delete m['deedTemplateHash'])).toThrow(ConfigError)
    expect(without((m) => (m['network'] = 7))).toThrow(ConfigError)
    expect(
      without(
        (m) =>
          ((m['deedAbi'] as { contracts: { DotkDeed: { compiled: unknown } } }).contracts.DotkDeed.compiled = {
            bytecode: 'x',
          })
      )
    ).toThrow(ConfigError)
    expect(without((m) => (m['gapTemplateHash'] = 'zz'))).toThrow(ConfigError)
    expect(without(() => undefined)().network).toBe(NET)
  })

  it('defaults to the bundled registry and the public api', () => {
    const dotk = new Dotk()
    expect(dotk.network).toBe(NET)
    expect(dotk.registryCovenantId).toBe(COVENANT_ID)
    expect(dotk.api?.base).toBe(directoryFor(NET) + API_VERSION_PATH)
  })

  /**
   * One directory per registry, and never one host for all of them.
   *
   * Each chain has a service of its own, so a single default would point a testnet client at
   * mainnet's directory, which answers every lookup with a covenant id this client refuses and
   * reads as a registry holding nothing. `https://dotk.name` in particular is the web app and
   * serves no API at all, so it must never appear as a base anywhere.
   */
  it('takes its default directory from the registry it resolved to', () => {
    expect(directoryFor('mainnet')).toBe('https://api.dotk.name')
    expect(directoryFor('testnet-10')).toBe('https://api-tn10.dotk.name')
    for (const base of Object.values(DIRECTORIES)) expect(base).not.toBe('https://dotk.name')
  })

  /** A registry with no directory is a caller's to name, and says so rather than going silent. */
  it('refuses to guess a directory it does not know', () => {
    expect(() => directoryFor('simnet')).toThrow(ConfigError)
    expect(() => directoryFor('simnet')).toThrow(/api/)
  })

  it('takes the host as given, trailing slash or not, and hangs the version off it', () => {
    expect(new Dotk({ api: 'http://localhost:7799/' }).api?.base).toBe(`http://localhost:7799${API_VERSION_PATH}`)
    expect(new Dotk({ api: 'http://localhost:7799' }).api?.base).toBe(`http://localhost:7799${API_VERSION_PATH}`)
  })

  it('refuses a base that already carries the version, naming the one to pass instead', () => {
    expect(() => new Dotk({ api: `https://api.dotk.name${API_VERSION_PATH}` })).toThrow(ConfigError)
    expect(() => new Dotk({ api: `https://api.dotk.name${API_VERSION_PATH}/` })).toThrow(
      /Pass https:\/\/api\.dotk\.name/
    )
  })

  it('refuses a concurrency that would fill no slot', () => {
    expect(() => new Dotk({ concurrency: NaN })).toThrow(ConfigError)
    expect(() => new Dotk({ concurrency: 0 })).toThrow(ConfigError)
    expect(() => new Dotk({ concurrency: 1.5 })).toThrow(ConfigError)
    expect(() => new Dotk({ concurrency: 1 })).not.toThrow()
  })

  it('refuses a network no bundled registry is on, and addresses each one it carries', () => {
    const other = NET === 'mainnet' ? 'testnet-10' : 'mainnet'
    if (DEPLOYMENTS[other]) expect(new Dotk({ network: other }).network).toBe(other)
    else expect(() => new Dotk({ network: other })).toThrow(ConfigError)
    expect(() => new Dotk({ network: 'nonsense-net' })).toThrow(ConfigError)
  })
})

describe('pure calls', () => {
  /**
   * Trimming is an index scan, so an interior run of whitespace costs what its length costs. A
   * regex anchored at the end alone retries from every position of such a run, and a pasted
   * megabyte of it would hold the thread for minutes.
   */
  it('reads a long interior run of whitespace in linear time', () => {
    const dotk = new Dotk({ api: null })
    const input = `x${' '.repeat(200_000)}x`
    const started = performance.now()
    expect(dotk.classify(input).kind).toBe('neither')
    expect(() => dotk.normalize(input)).toThrow(InvalidNameError)
    expect(performance.now() - started).toBeLessThan(500)
  })

  /** The set trimmed is Unicode's White_Space, the one Rust's `str::trim` removes, and not the one `String.trim` removes. */
  it('trims the whitespace set that the reference implementation trims', () => {
    const dotk = new Dotk({ api: null })
    expect(dotk.normalize('\u3000 kaspa\u0085\u2028')).toBe('kaspa')
    expect(() => dotk.normalize('\uFEFFkaspa')).toThrow(InvalidNameError)
  })

  /** The two figures `quote` computes, against both bundled manifests, where the fee is above the deposit and where it is below. */
  it('quotes what a registration locks and what it must fund', () => {
    for (const network of Object.keys(DEPLOYMENTS)) {
      const dotk = new Dotk({ api: null, network })
      const p = DEPLOYMENTS[network]!.params
      for (const name of ['a', 'ab', 'abc', 'abcd', 'abcde', 'a-longer-name']) {
        const q = dotk.quote(name)
        expect(q.name).toBe(name)
        expect(q.fee, `${network} ${name}`).toBe(feeForName(p, name))
        expect(q.bond).toBe(p.bond)
        expect(q.deposit).toBe(p.deposit)
        expect(q.gapValue).toBe(p.gap_value)
        expect(q.lockedValue, `${network} ${name}`).toBe(p.bond + p.gap_value)
        expect(q.totalToFund, `${network} ${name}`).toBe(
          p.bond + p.gap_value + Math.max(feeForName(p, name), p.deposit)
        )
      }
      // The fee follows the name's length, and the name is read as every call reads it.
      expect(dotk.quote('a').fee).toBeGreaterThan(dotk.quote('abcde').fee)
      expect(dotk.quote(' A.K ')).toEqual(dotk.quote('a'))
    }
  })

  const dotk = new Dotk({ api: null })

  it('normalizes what a user typed and refuses what cannot be a name', () => {
    expect(dotk.normalize(' Kaspa.K ')).toBe('kaspa')
    expect(() => dotk.normalize('-a')).toThrow(InvalidNameError)
    expect(() => dotk.normalize('')).toThrow(InvalidNameError)
  })

  it('displays, keys and derives from typed input', () => {
    expect(dotk.display('KASPA')).toBe('kaspa.k')
    expect(dotk.keyOf('Kaspa.k')).toBe(toHex(keyBytesOf('kaspa')))
    expect(dotk.ownerOf(schnorr.address!)).toEqual({ ownerType: 0, owner: schnorr.owner })
    expect(dotk.ownerOf(ecdsa.address!)).toEqual({ ownerType: 0x85, owner: ecdsa.owner })
    expect(dotk.deedAddress('Kaspa.k', schnorr.address!)).toBe(deedOf('kaspa', 0).address)
    expect(dotk.deedAddress('kaspa', ecdsa.address!)).toBe(deedOf('kaspa', 0x85).address)
  })

  it('refuses an address from another network', () => {
    expect(() => dotk.ownerOf(otherPrefix)).toThrow(InvalidAddressError)
    expect(() => dotk.deedAddress('kaspa', otherPrefix)).toThrow(/This registry lives on/)
  })

  it('needs the api for anything that asks it', async () => {
    await expect(dotk.resolveName('kaspa')).rejects.toThrow(ConfigError)
    await expect(dotk.status()).rejects.toThrow(ConfigError)
  })
})

describe('verify', () => {
  it('is the deed address held by the node under our covenant id', async () => {
    const deed = deedOf('kaspa', 0).address
    const node = fakeNode([{ address: deed, covenantId: COVENANT_ID.toUpperCase() }])
    const dotk = new Dotk({ api: null, node })
    expect(await dotk.verify('kaspa', schnorr.address!)).toBe(true)
    expect(await dotk.verify('a', schnorr.address!)).toBe(false)
    expect(node.asked[0]).toEqual([deed])
  })

  it('does not count a UTXO of another covenant, or none', async () => {
    const deed = deedOf('kaspa', 0).address
    const dotk = new Dotk({
      api: null,
      node: fakeNode([{ address: deed, covenantId: 'ff'.repeat(32) }, { address: deed }]),
    })
    expect(await dotk.verify('kaspa', schnorr.address!)).toBe(false)
  })

  it('throws rather than answer when the node cannot be asked', async () => {
    await expect(new Dotk({ api: null }).verify('kaspa', schnorr.address!)).rejects.toThrow(NodeError)
    const broken: Node = { getUtxosByAddresses: async () => Promise.reject(new Error('utxoindex is not enabled')) }
    await expect(new Dotk({ api: null, node: broken }).verify('kaspa', schnorr.address!)).rejects.toThrow(/utxoindex/)
  })
})

describe('resolveName', () => {
  const { fetchFn } = fakeFetch((url) => {
    if (url.endsWith('/names/kaspa'))
      return { status: 200, body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!) }
    if (url.endsWith('/names/a-b9')) return { status: 200, body: nameBody('a-b9', 4, covenantOwner.owner) }
    if (url.endsWith('/names/a')) return { status: 200, body: nameBody('a', 0x85, ecdsa.owner, ecdsa.address!) }
    if (url.endsWith('/names/free')) return { status: 404, body: { code: 'not_found', error: 'not registered' } }
    if (url.endsWith('/names/other'))
      return { status: 200, body: { ...nameBody('other', 0, schnorr.owner), registryCovenantId: 'ab'.repeat(32) } }
    return undefined
  })

  it('answers from the api, rebuilding the address and the deed address locally', async () => {
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    const r = await dotk.resolveName(' Kaspa.K ')
    expect(r).toMatchObject({
      name: 'kaspa',
      display: 'kaspa.k',
      address: schnorr.address,
      ownerType: 0,
      owner: schnorr.owner,
      proven: null,
    })
    expect(r!.deedAddress).toBe(deedOf('kaspa', 0).address)
    expect(r!.ownerCovenantId).toBeUndefined()
    expect((await dotk.resolveName('a'))!.address).toBe(ecdsa.address)
    expect(await dotk.resolveName('free')).toBeNull()
  })

  it('renders a covenant owner as no address', async () => {
    const r = await new Dotk({ api: 'http://api.test', fetch: fetchFn }).resolveName('A-B9')
    expect(r).toMatchObject({
      name: 'a-b9',
      display: 'a-b9.k',
      address: null,
      ownerType: 4,
      ownerCovenantId: covenantOwner.owner,
    })
    expect(r!.deedAddress).toBe(deedOf('a-b9', 4).address)
  })

  it('verifies against the node when one was given', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn, node })
    expect((await dotk.resolveName('kaspa'))!.proven).toBe(true)
    expect((await dotk.resolveName('a'))!.proven).toBe(false)
  })

  it('refuses an answer about another registry', async () => {
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn }).resolveName('other')).rejects.toThrow(
      RegistryMismatchError
    )
  })

  it('reads only not_found as an unregistered name, never the status alone', async () => {
    // A base pointing somewhere else 404s every route with no body of ours. Reading that as
    // "nobody owns this name" would answer null for every name in the registry.
    const elsewhere = fakeFetch(() => undefined)
    const dotk = new Dotk({ api: 'http://api.test', fetch: elsewhere.fetchFn })
    await expect(dotk.resolveName('kaspa')).rejects.toThrow(ApiError)
    await expect(dotk.addressFor('kaspa')).rejects.toThrow(ApiError)

    const otherCode = fakeFetch(() => ({ status: 404, body: { code: 'not_ready', error: 'catching up' } }))
    await expect(new Dotk({ api: 'http://api.test', fetch: otherCode.fetchFn }).resolveName('kaspa')).rejects.toThrow(
      ApiError
    )
  })

  it('derives the owning covenant id rather than adopting the one served beside it', async () => {
    const lying = fakeFetch((url) => {
      if (url.endsWith('/names/a-b9'))
        return {
          status: 200,
          body: { ...nameBody('a-b9', 4, covenantOwner.owner), ownerCovenantId: 'ff'.repeat(32) },
        }
      if (url.endsWith('/names/kaspa'))
        return {
          status: 200,
          body: { ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!), ownerCovenantId: 'ff'.repeat(32) },
        }
      return undefined
    })
    const dotk = new Dotk({ api: 'http://api.test', fetch: lying.fetchFn })
    // The owner the deed address was built on, not the field served next to it.
    expect((await dotk.resolveName('a-b9'))!.ownerCovenantId).toBe(covenantOwner.owner)
    // And never attached to a key-owned name, whatever the api says.
    expect((await dotk.resolveName('kaspa'))!.ownerCovenantId).toBeUndefined()
  })

  it('refuses a name before asking', async () => {
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn }).resolveName('no spaces')).rejects.toThrow(
      InvalidNameError
    )
  })
})

describe('namesOf', () => {
  /** A list in an answer is capped, so an API cannot choose how many derivations and node requests one call makes. */
  it('refuses an answer that lists more names than the cap, before deriving any of them', async () => {
    const many = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `n${i}`)
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { address: schnorr.address, names: many, registryCovenantId: COVENANT_ID },
    }))
    const node = fakeNode([])
    const e = await new Dotk({ api: 'http://api.test', fetch: fetchFn, node })
      .namesOf(schnorr.address!)
      .catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/names/)
    expect(node.asked).toEqual([])
  })

  const { fetchFn, calls } = fakeFetch((url) => {
    if (url.includes('/addresses/'))
      return {
        status: 200,
        body: { address: schnorr.address, names: ['a', 'kaspa'], cards: [], registryCovenantId: COVENANT_ID },
      }
    return undefined
  })

  it('lists the api answer with deed addresses derived from the input address', async () => {
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    const names = await dotk.namesOf(schnorr.address!)
    expect(names).toEqual([
      {
        name: 'a',
        display: 'a.k',
        deedAddress: deedOf('a', 0).address,
        proven: null,
        card: null,
        records: {},
        primary: false,
      },
      {
        name: 'kaspa',
        display: 'kaspa.k',
        deedAddress: deedOf('kaspa', 0).address,
        proven: null,
        card: null,
        records: {},
        primary: false,
      },
    ])
    expect(calls[0]).toBe(`http://api.test${API_VERSION_PATH}/addresses/${encodeURIComponent(schnorr.address!)}`)
  })

  it('verifies every name in one probe', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    const names = await new Dotk({ api: 'http://api.test', fetch: fetchFn, node }).namesOf(schnorr.address!)
    expect(names.map((n) => n.proven)).toEqual([false, true])
    expect(node.asked).toHaveLength(1)
  })

  it('refuses an address from another network before asking', async () => {
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn }).namesOf(otherPrefix)).rejects.toThrow(
      InvalidAddressError
    )
  })
})

describe('available', () => {
  const gap = gapOf('00'.repeat(32))
  const withKey = (kind: string, covering?: { lo: string; hi: string }) => ({
    key: 'x',
    kind,
    covering,
    registryCovenantId: COVENANT_ID,
    proven: true,
  })
  const { fetchFn } = fakeFetch((url) => {
    if (url.endsWith('/names/kaspa/key')) return { status: 200, body: withKey('active') }
    if (url.endsWith('/names/pending/key')) return { status: 200, body: withKey('pending') }
    if (url.endsWith('/names/free/key')) return { status: 200, body: withKey('free', { lo: gap.lo, hi: gap.hi }) }
    if (url.endsWith('/names/stale/key'))
      return { status: 200, body: withKey('free', { lo: gap.lo, hi: vectors.keyOf[0]!.key }) }
    return undefined
  })

  it('is the api word without a node', async () => {
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    expect(await dotk.available('kaspa')).toBe(false)
    expect(await dotk.available('pending')).toBe(false)
    expect(await dotk.available('free')).toBe(true)
  })

  it('is proven by the covering gap with a node', async () => {
    const node = fakeNode([{ address: gap.address, covenantId: COVENANT_ID }])
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn, node })
    expect(await dotk.available('free')).toBe(true)
    expect(node.asked[0]).toEqual([gap.address])
    expect(await new Dotk({ api: 'http://api.test', fetch: fetchFn, node: fakeNode([]) }).available('free')).toBe(false)
  })

  it('refuses to answer when the api names a gap that does not cover the key', async () => {
    // The api has contradicted itself. "false" would read as "registered"; nothing is known.
    const node = fakeNode([{ address: gap.address, covenantId: COVENANT_ID }])
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn, node }).available('stale')).rejects.toThrow(
      /does not contain/
    )
    expect(node.asked).toHaveLength(0)
  })

  it('answers a slot for every name asked about', async () => {
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    expect(await dotk.availableMany(['free', 'kaspa', 'free'])).toEqual([true, false, true])
  })
})

describe('lookup', () => {
  const gap = gapOf('00'.repeat(32))
  const key = (kind: string, over: Record<string, unknown> = {}) => ({
    key: toHex(keyBytesOf('kaspa')),
    kind,
    registryCovenantId: COVENANT_ID,
    proven: true,
    ...over,
  })
  const route = (kind: string, over?: Record<string, unknown>) =>
    fakeFetch((url) => {
      if (url.endsWith('/key')) return { status: 200, body: key(kind, over) }
      if (url.includes('/names/')) return { status: 200, body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!) }
      return undefined
    }).fetchFn

  it('tells the four states apart, where available collapses three of them', async () => {
    // `available` answers true for `free` alone and false for the other three, and `resolve`
    // answers null for everything but `active`.
    const pending = await new Dotk({ api: 'http://x', fetch: route('pending') }).lookup('kaspa')
    expect(pending).toMatchObject({ kind: 'pending', name: 'kaspa' })

    const unknown = await new Dotk({ api: 'http://x', fetch: route('ownerUnknown') }).lookup('kaspa')
    expect(unknown).toMatchObject({ kind: 'ownerUnknown', name: 'kaspa' })

    const free = await new Dotk({
      api: 'http://x',
      fetch: route('free', { covering: { lo: gap.lo, hi: gap.hi } }),
    }).lookup('kaspa')
    expect(free).toMatchObject({ kind: 'free', covering: { lo: gap.lo, hi: gap.hi } })

    const active = await new Dotk({ api: 'http://x', fetch: route('active') }).lookup(' KASPA.k ')
    expect(active.kind).toBe('active')
    expect(active.kind === 'active' && active.resolved.address).toBe(schnorr.address)
  })

  it('carries the reservation a wallet is waiting on', async () => {
    const deed = { deedAddress: 'kaspatest:whatever', acceptedDaa: 42 }
    const found = await new Dotk({ api: 'http://x', fetch: route('pending', { deed }) }).lookup('kaspa')
    expect(found).toMatchObject({ kind: 'pending', deedAddress: deed.deedAddress, acceptedDaa: 42 })
  })
})

describe('a registration before it completes', () => {
  it('derives the claim and the PENDING deed address the split mints', () => {
    const dotk = new Dotk({ api: null })
    // The claim commits to the scheme byte as well as the key, so two owners of one name give
    // two claims and two addresses.
    expect(dotk.claimOf('kaspa', schnorr.address!)).not.toBe(dotk.claimOf('kaspa', ecdsa.address!))
    expect(dotk.pendingDeedAddress('kaspa', schnorr.address!)).not.toBe(dotk.deedAddress('kaspa', schnorr.address!))
    // Pure and stable: what a wallet derives before broadcasting and asks the node afterwards.
    expect(dotk.pendingDeedAddress(' KASPA.k ', schnorr.address!)).toBe(
      dotk.pendingDeedAddress('kaspa', schnorr.address!)
    )
  })

  it('is what the node is asked for, and is answered from the node alone', async () => {
    const dotk0 = new Dotk({ api: null })
    const pending = dotk0.pendingDeedAddress('kaspa', schnorr.address!)
    const node = fakeNode([{ address: pending, covenantId: COVENANT_ID }])
    const dotk = new Dotk({ api: null, node })
    expect(await dotk.verifyPending('kaspa', schnorr.address!)).toBe(true)
    expect(node.asked[0]).toEqual([pending])
    expect(await new Dotk({ api: null, node: fakeNode([]) }).verifyPending('kaspa', schnorr.address!)).toBe(false)
  })
})

describe('status', () => {
  const health = (over: Record<string, unknown>) => ({
    healthy: true,
    caughtUp: true,
    tipDistance: 0,
    netBps: 10,
    active: 1,
    pending: 0,
    ownerUnknown: 0,
    registryCovenantId: COVENANT_ID,
    network: NET,
    ...over,
  })

  /** A covenant id that is not a string fails the gate as a mismatch rather than as a crash. */
  it('answers sameRegistry false for a covenant id that is not text', async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.endsWith('/health') ? { status: 200, body: health({ registryCovenantId: 123 }) } : undefined
    )
    const answer = await new Dotk({ api: 'http://x', fetch: fetchFn }).status()
    expect(answer.sameRegistry).toBe(false)
    expect(answer.registryCovenantId).toBe('123')
  })

  it('reads sameRegistry from covenant id and network, on 200 and on 503', async () => {
    const { fetchFn } = fakeFetch((url) => {
      if (url.endsWith('/health')) return { status: 503, body: health({ healthy: false, caughtUp: false }) }
      return undefined
    })
    expect(await new Dotk({ api: 'http://api.test', fetch: fetchFn }).status()).toEqual({
      sameRegistry: true,
      caughtUp: false,
      healthy: false,
      behind: null,
      behindSeconds: null,
      active: 1,
      pending: 0,
      ownerUnknown: 0,
      network: NET,
      registryCovenantId: COVENANT_ID,
    })
    const other = fakeFetch(() => ({ status: 200, body: health({ registryCovenantId: 'ab'.repeat(32) }) }))
    expect((await new Dotk({ api: 'http://api.test', fetch: other.fetchFn }).status()).sameRegistry).toBe(false)
    const otherNet = fakeFetch(() => ({ status: 200, body: health({ network: 'somewhere-else' }) }))
    expect((await new Dotk({ api: 'http://api.test', fetch: otherNet.fetchFn }).status()).sameRegistry).toBe(false)
  })

  it('subtracts the tip distance to say how far behind the api is', async () => {
    // `caughtUp` says whether the API is level; the distance is the client's own subtraction.
    const lagging = fakeFetch(() => ({
      status: 200,
      body: health({
        caughtUp: false,
        lastBlock: { hash: 'aa', blueScore: 900, daaScore: 900, timestamp: 0 },
        tipBlueScore: 1000,
      }),
    }))
    const behind = await new Dotk({ api: 'http://api.test', fetch: lagging.fetchFn }).status()
    expect(behind).toMatchObject({ caughtUp: false, behind: 100, behindSeconds: 10 })

    // Level, once its own confirmation depth is discounted.
    const level = fakeFetch(() => ({
      status: 200,
      body: health({
        tipDistance: 10,
        lastBlock: { hash: 'aa', blueScore: 990, daaScore: 990, timestamp: 0 },
        tipBlueScore: 1000,
      }),
    }))
    expect((await new Dotk({ api: 'http://api.test', fetch: level.fetchFn }).status()).behind).toBe(0)

    // Neither end observed is not the same answer as current.
    const blind = fakeFetch(() => ({ status: 200, body: health({ lastBlock: null, tipBlueScore: null }) }))
    expect((await new Dotk({ api: 'http://api.test', fetch: blind.fetchFn }).status()).behind).toBeNull()
  })

  it('reports other statuses and unreachable apis as ApiError', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 500, body: { code: 'internal', error: 'db' } }))
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn }).status()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      detail: 'db',
      // The whole point of the code: a caller decides what to do next without reading 'db'.
      code: 'internal',
    })
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const e = await new Dotk({ api: 'http://api.test', fetch: down }).status().catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(0)
  })

  it('carries a refusal code the caller can branch on, whether or not it knows it', async () => {
    // Two 400s from one endpoint mean different things, and only the code says which.
    const named = fakeFetch(() => ({
      status: 400,
      body: { code: 'invalid_query', error: 'limit must be between 1 and 100' },
    }))
    const e = await new Dotk({ api: 'http://api.test', fetch: named.fetchFn }).status().catch((e: unknown) => e)
    expect((e as ApiError).code).toBe('invalid_query')

    // A code from a newer indexer survives rather than being dropped: a caller can still log it.
    const unknown = fakeFetch(() => ({ status: 400, body: { code: 'from_a_later_indexer', error: 'nope' } }))
    const later = await new Dotk({ api: 'http://api.test', fetch: unknown.fetchFn }).status().catch((e: unknown) => e)
    expect((later as ApiError).code).toBe('from_a_later_indexer')

    // A body with no code at all leaves it undefined rather than inventing one.
    const bare = fakeFetch(() => ({ status: 500, body: { error: 'db' } }))
    const plain = await new Dotk({ api: 'http://api.test', fetch: bare.fetchFn }).status().catch((e: unknown) => e)
    expect((plain as ApiError).code).toBeUndefined()
  })

  it('passes the abort signal through', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: health({}) }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      new Dotk({ api: 'http://api.test', fetch: fetchFn }).status({ signal: controller.signal })
    ).rejects.toThrow(/aborted/)
  })
})

describe('history', () => {
  it('refuses a page with more entries than the cap', async () => {
    const entries = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => ({
      op: 'transfer',
      blueScore: i,
      daaScore: i,
      blockTime: 1_750_000_000_000 + i,
      blockHash: 'aa'.repeat(32),
      txid: 'bb'.repeat(32),
    }))
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: {
        key: 'cc'.repeat(32),
        total: entries.length,
        limit: entries.length,
        offset: 0,
        complete: true,
        entries,
        registryCovenantId: COVENANT_ID,
      },
    }))
    await expect(new Dotk({ api: 'http://x', fetch: fetchFn }).history('kaspa')).rejects.toThrow(ApiError)
  })

  const entry = (op: string, blueScore: number) => ({
    op,
    blueScore,
    daaScore: blueScore * 2,
    blockTime: 1_750_000_000_000 + blueScore,
    blockHash: 'aa'.repeat(32),
    txid: 'bb'.repeat(32),
  })
  const page = (over: Record<string, unknown> = {}) => ({
    key: 'cc'.repeat(32),
    total: 3,
    limit: 5,
    offset: 0,
    complete: true,
    entries: [entry('transfer', 3), entry('activate', 2), entry('register', 1)],
    registryCovenantId: COVENANT_ID,
    ...over,
  })

  it('asks by the key of the typed name, and says which name it answered for', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: page() }))
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    const history = await dotk.history('  Alice.K ')

    // The caller types a name; the registry records history against the key it hashes to, and
    // the package is what closes that gap.
    expect(calls[0]).toBe(`http://api.test${API_VERSION_PATH}/keys/${dotk.keyOf('alice')}/history`)
    expect(history.name).toBe('alice')
    expect(history.key).toBe(dotk.keyOf('alice'))
    expect(history.entries.map((e) => e.op)).toEqual(['transfer', 'activate', 'register'])
    expect(history.complete).toBe(true)
    expect(history.total).toBe(3)
  })

  it('pages only when asked, and says so in the query', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: page({ limit: 2, offset: 4 }) }))
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    await dotk.history('alice', { limit: 2, offset: 4 })
    expect(calls[0]).toContain('?limit=2&offset=4')

    // No page given is no query string: the service's own default is the one default.
    await dotk.history('alice')
    expect(calls[1]).not.toContain('?')
  })

  it('refuses a name that could not be one, before asking anything', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: page() }))
    const dotk = new Dotk({ api: 'http://api.test', fetch: fetchFn })
    await expect(dotk.history('not valid!')).rejects.toThrow(InvalidNameError)
    expect(calls).toEqual([])
  })

  it('refuses a history about another registry', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: page({ registryCovenantId: 'ab'.repeat(32) }) }))
    await expect(new Dotk({ api: 'http://api.test', fetch: fetchFn }).history('alice')).rejects.toThrow(
      RegistryMismatchError
    )
  })

  it('needs the api, and says which call it was', async () => {
    await expect(new Dotk({ api: null }).history('alice')).rejects.toThrow(ConfigError)
  })
})

describe('classify', () => {
  const dotk = new Dotk({ api: null })

  it('tells a name, an address and neither apart, without throwing', () => {
    expect(dotk.classify(' Kaspa.K ')).toEqual({ kind: 'name', name: 'kaspa', display: 'kaspa.k' })
    expect(dotk.classify(` ${schnorr.address!} `)).toEqual({ kind: 'address', address: schnorr.address })
    expect(dotk.classify(otherPrefix).kind).toBe('neither')
    expect(dotk.classify('').kind).toBe('neither')
    expect(dotk.classify('no spaces').kind).toBe('neither')
    expect(dotk.classify('-a').kind).toBe('neither')
  })

  it('says why, so a field can show it', () => {
    const other = dotk.classify(otherPrefix)
    expect(other.kind === 'neither' && other.reason).toMatch(/This registry lives on/)
    const bad = dotk.classify('-a')
    expect(bad.kind === 'neither' && bad.reason).toMatch(/hyphen/)
  })
})

describe('the api answering nonsense', () => {
  it('refuses a lookup whose covenant id is not text, as an api error', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!), registryCovenantId: 123 },
    }))
    const e = await new Dotk({ api: 'http://x', fetch: fetchFn }).resolveName('kaspa').catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/registry covenant id/)
  })

  /**
   * A body that arrives a byte at a time is more chunks than one call can take as arguments, and
   * it still reads. Node 22 drips it far slower than a later runtime, so the test takes its own
   * timeout rather than the default.
   */
  it('reads a body that arrives in more chunks than a spread can carry', async () => {
    const text = JSON.stringify({
      ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!),
      registryCovenantId: COVENANT_ID,
    })
    const bytes = new TextEncoder().encode(text)
    const drip = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            for (let i = 0; i < 150_000; i++) controller.enqueue(new Uint8Array(1).fill(0x20))
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const found = await new Dotk({ api: 'http://x', fetch: drip as unknown as typeof fetch }).resolveName('kaspa')
    expect(found?.address).toBe(schnorr.address)
  }, 30_000)

  /** A fetch with no stream buffers the whole body, and the cap still holds, measured after the fact. */
  it('caps a body from a fetch that gives no stream', async () => {
    const streamless = async () =>
      ({
        ok: true,
        status: 200,
        body: null,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => `{"names":"${'a'.repeat(MAX_BODY_BYTES + 1)}"}`,
      }) as unknown as Response
    const e = await new Dotk({ api: 'http://x', fetch: streamless as unknown as typeof fetch })
      .resolveName('kaspa')
      .catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/bytes, past the/)
  })

  /** The transport's own error rides on the one this package throws, so a caller can read it. */
  it('carries the transport error as the cause of the api error', async () => {
    const boom = new TypeError('fetch failed')
    const failing = async () => {
      throw boom
    }
    const e = await new Dotk({ api: 'http://x', fetch: failing as unknown as typeof fetch })
      .resolveName('kaspa')
      .catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).status).toBe(0)
    expect((e as ApiError).cause).toBe(boom)
  })

  it('is an ApiError, not a bare TypeError from a derivation', async () => {
    for (const owner of ['zz'.repeat(32), 'ab', '']) {
      const { fetchFn } = fakeFetch(() => ({
        status: 200,
        body: { ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!), owner },
      }))
      const e = await new Dotk({ api: 'http://x', fetch: fetchFn }).resolveName('kaspa').catch((e: unknown) => e)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).message).toMatch(/unusable owner/)
    }
  })

  it('is an ApiError when the body is not JSON at all', async () => {
    const html = (async () =>
      new Response('<!doctype html><h1>404</h1>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    for (const call of [
      (d: Dotk) => d.resolveName('kaspa'),
      (d: Dotk) => d.status(),
      (d: Dotk) => d.namesOf(schnorr.address!),
    ]) {
      const e = await call(new Dotk({ api: 'http://x', fetch: html })).catch((e: unknown) => e)
      expect(e).toBeInstanceOf(ApiError)
      expect(e).toBeInstanceOf(DotkError)
      expect((e as ApiError).message).toMatch(/not the JSON this call expects/)
    }
  })

  it('is an ApiError when the covering gap is not a pair of keys', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: {
        key: 'x',
        kind: 'free',
        covering: { lo: 'oops', hi: 'oops' },
        registryCovenantId: COVENANT_ID,
        proven: true,
      },
    }))
    const e = await new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
      .available('kaspa')
      .catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/unusable covering gap/)
  })

  it('is an ApiError rather than a body held whole, past what a call reads', async () => {
    const huge = (async () =>
      new Response('{"names":"' + 'a'.repeat(MAX_BODY_BYTES + 1) + '"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const e = await new Dotk({ api: 'http://x', fetch: huge }).resolveName('kaspa').catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/past the .* this call reads/)
  })

  it('asks with no-store, so no cache of the caller outlives the answer', async () => {
    const seen: RequestInit[] = []
    const noting = (async (_input: unknown, init: RequestInit) => {
      seen.push(init)
      return new Response(JSON.stringify(nameBody('kaspa', 0, schnorr.owner, schnorr.address!)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await new Dotk({ api: 'http://x', fetch: noting }).resolveName('kaspa')
    expect(seen[0]?.cache).toBe('no-store')
  })
})

describe('a node that cannot see covenant ids', () => {
  it('is refused rather than read as a refusal', async () => {
    const blind = fakeNode([{ address: deedOf('kaspa', 0).address }])
    const e = await new Dotk({ api: null, node: blind }).verify('kaspa', schnorr.address!).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(NodeError)
    expect((e as NodeError).message).toMatch(/no covenant id/)
  })

  it('is not confused with a deed that simply is not there', async () => {
    expect(await new Dotk({ api: null, node: fakeNode([]) }).verify('kaspa', schnorr.address!)).toBe(false)
  })
})

describe('addressFor', () => {
  const { fetchFn } = fakeFetch((url) => {
    if (url.endsWith('/names/kaspa'))
      return { status: 200, body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!) }
    if (url.endsWith('/names/a-b9')) return { status: 200, body: nameBody('a-b9', 4, covenantOwner.owner) }
    if (url.endsWith('/names/free')) return { status: 404, body: { code: 'not_found', error: 'not registered' } }
    return undefined
  })

  it('is the address to pay, or null when there is none', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    expect(await dotk.addressFor(' Kaspa.K ')).toBe(schnorr.address)
    expect(await dotk.addressFor('free')).toBeNull()
    expect(await dotk.addressFor('a-b9')).toBeNull()
  })

  it('refuses to answer a name the node refutes', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
    const e = await dotk.addressFor('kaspa').catch((e: unknown) => e)
    expect(e).toBeInstanceOf(RefutedError)
    expect((e as RefutedError).nameOf).toBe('kaspa')
    expect((e as RefutedError).deedAddress).toBe(deedOf('kaspa', 0).address)
  })

  it('answers when the node holds the deed', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    expect(await new Dotk({ api: 'http://x', fetch: fetchFn, node }).addressFor('kaspa')).toBe(schnorr.address)
  })
})

describe('batches', () => {
  const { fetchFn, calls } = fakeFetch((url) => {
    if (url.endsWith('/names/kaspa'))
      return { status: 200, body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!) }
    if (url.endsWith('/names/a')) return { status: 200, body: nameBody('a', 0x85, ecdsa.owner, ecdsa.address!) }
    if (url.endsWith('/names/free')) return { status: 404, body: { code: 'not_found', error: 'not registered' } }
    if (url.includes('/addresses/'))
      return {
        status: 200,
        body: {
          ownerType: 0,
          owner: schnorr.owner,
          address: schnorr.address,
          names: ['kaspa', 'a'],
          cards: [],
          registryCovenantId: COVENANT_ID,
        },
      }
    return undefined
  })

  it('resolves many in the order asked, and asks the node once', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    const resolved = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).resolveMany(['Kaspa.k', 'free', 'a'])
    expect(resolved.map((r) => r?.name ?? null)).toEqual(['kaspa', null, 'a'])
    expect(resolved.map((r) => r?.proven ?? null)).toEqual([true, null, false])
    expect(node.asked).toHaveLength(1)
    expect(node.asked[0]).toHaveLength(2)
  })

  it('refuses the whole batch on one bad name, before asking anything', async () => {
    calls.length = 0
    await expect(new Dotk({ api: 'http://x', fetch: fetchFn }).resolveMany(['kaspa', '-no'])).rejects.toThrow(
      InvalidNameError
    )
    expect(calls).toHaveLength(0)
  })

  it('lists many addresses with one node probe', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    const lists = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).namesOfMany([
      schnorr.address!,
      schnorr.address!,
    ])
    expect(lists).toHaveLength(2)
    expect(node.asked).toHaveLength(1)
    expect(node.asked[0]).toHaveLength(4)
  })

  it('holds the concurrency limit', async () => {
    let live = 0
    let peak = 0
    const slow = (async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      return new Response(JSON.stringify(nameBody('kaspa', 0, schnorr.owner, schnorr.address!)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    // Distinct names: repeats are one request, which is what `holds one request per distinct
    // name` covers, and would leave nothing here for the pool to hold back.
    await new Dotk({ api: 'http://x', fetch: slow, concurrency: 3 }).resolveMany(
      Array.from({ length: 12 }, (_, i) => `name${i}`)
    )
    expect(peak).toBe(3)
  })

  it('holds one request per distinct name, and still answers a slot for each', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      status: 200,
      body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!),
    }))
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    const asked = ['kaspa', 'a', 'kaspa', 'kaspa.k', ' KASPA ']
    const answers = await dotk.resolveMany(asked)
    expect(answers).toHaveLength(asked.length)
    // Four of the five normalize to `kaspa`, so two names are asked about.
    expect(calls).toHaveLength(2)
    expect(answers.every((r) => r !== null)).toBe(true)
  })
})

describe('the display convention', () => {
  it('is shortest first, then alphabetical, and is a total order', () => {
    expect(['kaspa', 'a', 'bb', 'ab'].sort(displayOrder)).toEqual(['a', 'ab', 'bb', 'kaspa'])
  })

  const listing = (owned: string[]) =>
    fakeFetch(() => ({
      status: 200,
      body: {
        ownerType: 0,
        owner: schnorr.owner,
        address: schnorr.address,
        names: owned,
        cards: [],
        registryCovenantId: COVENANT_ID,
      },
    })).fetchFn

  it('orders what an address owns', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: listing(['kaspa', 'a']) })
    expect((await dotk.namesOf(schnorr.address!)).map((n) => n.name)).toEqual(['a', 'kaspa'])
    expect(await dotk.displayNameFor(schnorr.address!)).toBe('a.k')
  })

  /** The batch form answers one slot per address, in the order asked, over one API round each. */
  it('answers a display name per address, in order', async () => {
    const { fetchFn, calls } = fakeFetch((url) => {
      const address = decodeURIComponent(/\/addresses\/([^/?]+)/.exec(url)?.[1] ?? '')
      const names = address === schnorr.address ? ['kaspa', 'a'] : address === ecdsa.address ? ['b'] : []
      return { status: 200, body: { address, names, cards: [], registryCovenantId: COVENANT_ID } }
    })
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    const shown = await dotk.displayNamesFor([schnorr.address!, ecdsa.address!])
    expect(shown).toEqual(['a.k', 'b.k'])
    expect(calls.filter((u) => u.includes('/addresses/'))).toHaveLength(2)
  })

  it('is null for an address that owns nothing', async () => {
    expect(await new Dotk({ api: 'http://x', fetch: listing([]) }).displayNameFor(schnorr.address!)).toBeNull()
  })

  it('shows only a name the node holds, when there is a node', async () => {
    const node = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    const dotk = new Dotk({ api: 'http://x', fetch: listing(['kaspa', 'a']), node })
    expect(await dotk.displayNameFor(schnorr.address!)).toBe('kaspa.k')
  })
})

describe('deadlines', () => {
  const hang = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch

  /** The helper an adapter borrows: a deadline fires, a caller's abort relays, and null waits. */
  it('runs work under a deadline, relays the caller signal, and waits with none', async () => {
    const stuck = () => new Promise<never>(() => undefined)
    const e = await withDeadline('probe', 10, undefined, stuck).catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TimeoutError)
    expect((e as Error).message).toBe('the probe did not answer within 10ms')

    const controller = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const relayed = withDeadline('probe', 1000, controller.signal, (signal) => {
      seen.push(signal)
      return new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason as Error)))
    })
    controller.abort(new Error('the user pressed cancel'))
    await expect(relayed).rejects.toThrow('the user pressed cancel')
    expect(seen[0]).not.toBe(controller.signal)

    const done = new AbortController()
    done.abort(new Error('already'))
    await expect(withDeadline('probe', null, done.signal, stuck)).rejects.toThrow('already')
    expect(await withDeadline('probe', null, undefined, async () => 'answer')).toBe('answer')
  })

  /** A `work` that throws before its first await rejects as one that rejects, in every form. */
  it('turns a synchronous throw from the work into a rejection, and cleans up after it', async () => {
    const boom = (): Promise<never> => {
      throw new Error('sync boom')
    }
    const live = new AbortController()
    for (const [timeoutMs, signal] of [
      [null, undefined],
      [1000, undefined],
      [null, live.signal],
      [1000, live.signal],
    ] as const) {
      await expect(withDeadline('probe', timeoutMs, signal, boom)).rejects.toThrow('sync boom')
    }
    // Nothing of those calls holds the signal, so a later abort reaches no listener of theirs.
    live.abort(new Error('after'))
  })

  it('gives up on an api that never answers', async () => {
    const e = await new Dotk({ api: 'http://x', fetch: hang, timeoutMs: 20 }).status().catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TimeoutError)
    expect((e as TimeoutError).message).toMatch(/api did not answer within 20ms/)
  })

  it('gives up on a node that never answers', async () => {
    const stuck: Node = { getUtxosByAddresses: () => new Promise<Utxo[]>(() => undefined) }
    const e = await new Dotk({ api: null, node: stuck, timeoutMs: 20 })
      .verify('kaspa', schnorr.address!)
      .catch((e: unknown) => e)
    expect(e).toBeInstanceOf(TimeoutError)
    expect((e as TimeoutError).message).toMatch(/node did not answer/)
  })

  it('waits for ever when asked to', async () => {
    const slow = (async () => {
      await new Promise((r) => setTimeout(r, 30))
      return new Response(
        JSON.stringify({ healthy: true, caughtUp: true, registryCovenantId: COVENANT_ID, network: NET }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch
    expect((await new Dotk({ api: 'http://x', fetch: slow, timeoutMs: null }).status()).sameRegistry).toBe(true)
  })
})

describe('the network the client addresses', () => {
  it('refuses a sibling testnet, not just another prefix', () => {
    // Every `testnet-*` shares the `kaspatest:` prefix, so the prefix cannot decide this.
    // testnet-11 is the sibling no registry is deployed on.
    const sibling = 'testnet-11'
    expect(() => new Dotk({ network: sibling })).toThrow(ConfigError)
    expect(new Dotk({ network: NET }).network).toBe(NET)
  })
})

describe('available, when the api leaves the question open', () => {
  const body = (over: Record<string, unknown>) => ({
    key: 'x',
    kind: 'free',
    registryCovenantId: COVENANT_ID,
    proven: true,
    ...over,
  })

  it('refuses to answer when the api names no covering gap and a node could have proven one', async () => {
    // Answering `false` here would say "taken" when it meant "cannot tell".
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: body({}) }))
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
    await expect(dotk.available('kaspa')).rejects.toThrow(/names no gap covering/)
  })

  it('still answers the api word when there is no node to prove anything with', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 200, body: body({}) }))
    expect(await new Dotk({ api: 'http://x', fetch: fetchFn }).available('kaspa')).toBe(true)
  })
})

describe('the api client underneath', () => {
  /**
   * Each of these is a public method on an exported class whose only job is to ask the right
   * path. Nothing else in the suite would notice if one asked the wrong one.
   */
  it('asks the path each call is named for', async () => {
    const seen: string[] = []
    const fetchFn = (async (input: string | URL) => {
      seen.push(new URL(String(input)).pathname)
      return new Response(JSON.stringify({ registryCovenantId: COVENANT_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const api = new Dotk({ api: 'http://x', fetch: fetchFn }).api!
    await api.name('kaspa')
    await api.address(schnorr.address!)
    await api.nameKey('kaspa')
    await api.key('ab'.repeat(32))
    await api.owner(0, 'cd'.repeat(32))
    await api.keyspace()
    await api.health()
    await api.genesis()
    // Every route hangs off the version segment, which the caller does not write.
    expect(seen).toEqual(
      [
        '/names/kaspa',
        `/addresses/${encodeURIComponent(schnorr.address!)}`,
        '/names/kaspa/key',
        `/keys/${'ab'.repeat(32)}`,
        `/owners/0/${'cd'.repeat(32)}`,
        '/keyspace',
        '/health',
        '/genesis',
      ].map((path) => API_VERSION_PATH + path)
    )
  })

  it('pages a history by the query the caller asked for', async () => {
    const seen: string[] = []
    const fetchFn = (async (input: string | URL) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ registryCovenantId: COVENANT_ID }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await new Dotk({ api: 'http://x', fetch: fetchFn }).api!.history('ab'.repeat(32), { limit: 3, offset: 6 })
    expect(seen[0]).toContain('limit=3')
    expect(seen[0]).toContain('offset=6')
  })
})

describe('addresses this registry cannot hold an owner for', () => {
  it('refuses an ECDSA address whose SEC1 prefix is neither 2 nor 3', () => {
    const bad = encodeAddress(
      new Dotk({ api: null }).prefix,
      Version.PubKeyECDSA,
      Uint8Array.of(0x04, ...new Uint8Array(32))
    )
    expect(() => new Dotk({ api: null }).ownerOf(bad)).toThrow(/SEC1 prefix/)
  })

  it('refuses an address version it has no owner scheme for', () => {
    const dotk = new Dotk({ api: null })
    expect(() => decodeAddress(encodeAddress(dotk.prefix, 5, new Uint8Array(32)))).toThrow(/unknown address version/)
  })

  it('refuses to name an address for an owner scheme it does not know', () => {
    expect(() => ownerAddress('kaspatest', 0x7f, new Uint8Array(32))).toThrow(/unknown owner type/)
  })
})

describe('classify keeps its promise never to throw', () => {
  const dotk = new Dotk({ api: null })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array', []],
  ])('answers rather than throwing for %s', (_label, value) => {
    const answer = dotk.classify(value as unknown as string)
    expect(answer.kind).toBe('neither')
    expect(answer.kind === 'neither' && answer.reason).toBeTruthy()
  })

  it('names what it got, so the caller can see their own bug', () => {
    const answer = dotk.classify(undefined as unknown as string)
    expect(answer.kind === 'neither' && answer.reason).toMatch(/undefined/)
    expect((dotk.classify(null as unknown as string) as { reason: string }).reason).toMatch(/null/)
  })
})

describe('cards', () => {
  const vector = vectors.card.find((v) => v.network === NET && v.name === 'kaspa' && v.spenderType === 0)!
  const TXID = 'aa'.repeat(32)
  const cardOut = (v: typeof vector, txid = TXID, extra: Partial<CardOut> = {}): CardOut => ({
    name: v.name,
    key: toHex(keyBytesOf(v.name)),
    outpointTxid: txid,
    outpointIndex: 1,
    value: CARD_VALUE,
    spenderType: v.spenderType,
    spender: v.spender,
    spenderAddress: schnorr.address!,
    cardAddress: v.address,
    recordsHash: v.recordsHash,
    blob: v.blob,
    live: true,
    ...extra,
  })
  /** A card for `name` from the schnorr key, with these records, as the API would list it. */
  const cardFor = (name: string, records: Records, txid = TXID): CardOut => {
    const blob = encodeRecords(records)
    const state = cardState(keyBytesOf(name), recordsOf(blob), 0, hex32(schnorr.owner, 'owner'))
    return {
      ...cardOut(vector, txid),
      name,
      key: toHex(state.key),
      cardAddress: cardAddress(new Dotk({ api: null }).prefix, state),
      recordsHash: toHex(state.records),
      blob: toHex(blob),
    }
  }
  const withCard = (card?: CardOut) =>
    fakeFetch(() => ({
      status: 200,
      body: { ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!), ...(card ? { card } : {}) },
    })).fetchFn
  const deed = (name: string, txid: string, daaScore: number, index = 0): Utxo => ({
    address: deedOf(name, 0).address,
    covenantId: COVENANT_ID,
    transactionId: txid,
    index,
    daaScore,
  })
  const listing = (owned: string[], cards: CardOut[]) =>
    fakeFetch(() => ({
      status: 200,
      body: {
        ownerType: 0,
        owner: schnorr.owner,
        address: schnorr.address,
        names: owned,
        cards,
        registryCovenantId: COVENANT_ID,
      },
    })).fetchFn

  it('parses the listed card and takes its records, unverified without a node', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)) })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.card).toMatchObject({
      name: 'kaspa',
      address: vector.address,
      outpointTxid: TXID,
      spenderAddress: schnorr.address,
      records: vector.records,
      live: true,
      proven: null,
    })
    expect(found.records).toEqual(vector.records)
  })

  it('answers no card for a name the api lists none for', async () => {
    const found = (await new Dotk({ api: 'http://x', fetch: withCard() }).resolveName('kaspa'))!
    expect(found.card).toBeNull()
    expect(found.records).toEqual({})
  })

  it('proves a card at output 1 of the deed transaction', async () => {
    const node = fakeNode([deed('kaspa', TXID, 5), { address: vector.address, transactionId: TXID, index: 1 }])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.proven).toBe(true)
    expect(found.card!.proven).toBe(true)
    expect(found.records).toEqual(vector.records)
    // Deed and card addresses are both known before either is asked for, so they go together.
    expect(node.asked).toHaveLength(1)
    expect(node.asked[0]).toEqual([found.deedAddress, vector.address])
  })

  it('does not read a card UTXO as a registry client blind to covenant ids', async () => {
    // A card sits at a plain P2SH and carries no covenant id. Counting one toward that check
    // would make it fire whenever a name is absent and its card is not.
    const node = fakeNode([{ address: vector.address, transactionId: TXID, index: 1 }])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.proven).toBe(false)
    expect(found.card!.proven).toBe(false)
  })

  /** A listing's value is read as a figure and never trusted as one, and a refusal this package worded goes up unchanged. */
  it('refuses a card value that is not an amount, without wrapping its own refusal twice', async () => {
    const odd = cardOut(vector, TXID, { value: 'lots' as unknown as number })
    const e = await new Dotk({ api: 'http://x', fetch: withCard(odd) }).resolveName('kaspa').catch((e: unknown) => e)
    expect(e).toBeInstanceOf(ApiError)
    expect((e as ApiError).message).toMatch(/card value/)
    // A refusal this package worded, the list cap, goes up unwrapped.
    const many = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `n${i}`)
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { address: schnorr.address, names: many, cards: [], registryCovenantId: COVENANT_ID },
    }))
    const capped = await new Dotk({ api: 'http://x', fetch: fetchFn })
      .namesOf(schnorr.address!)
      .catch((e: unknown) => e)
    expect((capped as ApiError).message).toMatch(/^the API answered with \d+ names, past the/)
    expect((capped as ApiError).message).not.toMatch(/unusable/)
  })

  /**
   * A page of addresses is as many capped answers, and the batch names all of it. The derivation
   * yields between chunks, and a cancel that lands after the last answer, with no node to ask,
   * is seen at the next chunk and stops the call there.
   */
  it('names a page of addresses whole, and stops deriving where the caller cancelled', async () => {
    const page = Array.from({ length: 40 }, () =>
      encodeAddress(new Dotk({ api: null }).prefix, Version.PubKey, secp.getPublicKey(secp.utils.randomSecretKey()))
    )
    const thirty = Array.from({ length: 30 }, (_, i) => `n${i}`)
    const controller = new AbortController()
    let armed = false
    let answered = 0
    const { fetchFn, calls } = fakeFetch((url) => {
      const address = decodeURIComponent(url.split('/addresses/')[1]!)
      if (++answered === page.length && armed) controller.abort(new Error('the screen went away'))
      return { status: 200, body: { address, names: thirty, cards: [], registryCovenantId: COVENANT_ID } }
    })
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    const whole = await dotk.namesOfMany(page)
    expect(whole.map((names) => names.length)).toEqual(page.map(() => 30))
    // The same page under a signal that fires on the last answer. Every request went out, and
    // the derivation of 1,200 names stopped at a chunk boundary rather than answering.
    armed = true
    answered = 0
    calls.length = 0
    await expect(dotk.namesOfMany(page, { signal: controller.signal })).rejects.toThrow(/the screen went away/)
    expect(calls.length).toBe(page.length)
    expect(controller.signal.aborted).toBe(true)
  })

  /** A name the package refuses, listed by the API, is the API's fault and reads as one. */
  it('reads a name it refuses in an answer as an unusable answer', async () => {
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { address: schnorr.address, names: ['has space'], cards: [], registryCovenantId: COVENANT_ID },
    }))
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    for (const call of [() => dotk.namesOf(schnorr.address!), () => dotk.namesOfMany([schnorr.address!])]) {
      const e = await call().catch((e: unknown) => e)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).message).toMatch(/unusable name list/)
    }
  })

  /** A cancel settles the call wherever the work is, with the caller's own reason. */
  it('rejects a cancelled call that had nothing left to yield at', async () => {
    const few = ['n0', 'n1', 'n2']
    const controller = new AbortController()
    const { fetchFn } = fakeFetch(() => {
      controller.abort(new Error('closed'))
      return { status: 200, body: { address: schnorr.address, names: few, cards: [], registryCovenantId: COVENANT_ID } }
    })
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, timeoutMs: null })
    await expect(dotk.namesOf(schnorr.address!, { signal: controller.signal })).rejects.toThrow(/closed/)
  })

  /**
   * A cancel that lands while the names are being derived stops the work at its next chunk. The
   * node is never asked, which is what the relay into the work and the chunking together buy.
   */
  it('stops the work at its next chunk after a cancel, and never asks the node', async () => {
    const page = Array.from({ length: 4 }, () =>
      encodeAddress(new Dotk({ api: null }).prefix, Version.PubKey, secp.getPublicKey(secp.utils.randomSecretKey()))
    )
    const many = Array.from({ length: 250 }, (_, i) => `n${i}`)
    const controller = new AbortController()
    let answered = 0
    const { fetchFn } = fakeFetch((url) => {
      const address = decodeURIComponent(url.split('/addresses/')[1]!)
      if (++answered === page.length) setTimeout(() => controller.abort(new Error('later')), 0)
      return { status: 200, body: { address, names: many, cards: [], registryCovenantId: COVENANT_ID } }
    })
    const node = fakeNode([])
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node })
    await expect(dotk.namesOfMany(page, { signal: controller.signal })).rejects.toThrow(/later/)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(node.asked).toEqual([])
  })

  /** The deadline covers a card list's derivation as it covers a name list's. */
  it('holds a card list to the deadline', async () => {
    const cards = Array.from({ length: 3_000 }, () => cardOut(vector, TXID))
    const { fetchFn } = fakeFetch(() => ({
      status: 200,
      body: { spenderType: 0, spender: vector.spender, cards, registryCovenantId: COVENANT_ID },
    }))
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, timeoutMs: 5 })
    await expect(dotk.cardsOf(schnorr.address!)).rejects.toBeInstanceOf(TimeoutError)
  })

  /** The yield is a turn of the event loop, and an aborted signal stops at it. */
  it('yields a macrotask, and refuses to go on for an aborted signal', async () => {
    let ticked = false
    setTimeout(() => (ticked = true), 0)
    await yieldNow()
    expect(ticked).toBe(true)
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(yieldNow(controller.signal)).rejects.toThrow(/gone/)
  })

  it('refutes a card at another output of the deed transaction', async () => {
    const listed = cardOut(vector, TXID, { outpointIndex: 2 })
    const node = fakeNode([deed('kaspa', TXID, 5), { address: vector.address, transactionId: TXID, index: 2 }])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(listed), node })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.card!.proven).toBe(false)
    expect(found.records).toEqual({})
  })

  it('refutes a card from an older transfer, and drops its records', async () => {
    const node = fakeNode([
      deed('kaspa', 'bb'.repeat(32), 5),
      { address: vector.address, transactionId: TXID, index: 1 },
    ])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.proven).toBe(true)
    expect(found.card!.proven).toBe(false)
    expect(found.records).toEqual({})
  })

  it('proves a card on the UTXO rule 2 names, and says which rule refused the rest', async () => {
    const node = fakeNode([deed('kaspa', TXID, 5)])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node })
    const card = (await dotk.resolveName('kaspa'))!.card!
    expect(card.proven).toBe(false)
    expect(card.refusal).toMatch(/^rule 1:/)
    // The node holds the live card at the deed's own transaction while the index listed an older
    // outpoint: the card proves, and carries the outpoint the node holds it at.
    const lagging = cardOut(vector, 'dd'.repeat(32))
    const current = (await new Dotk({
      api: 'http://x',
      fetch: withCard(lagging),
      node: fakeNode([deed('kaspa', TXID, 5), { address: vector.address, transactionId: TXID, index: 1 }]),
    }).resolveName('kaspa'))!.card!
    expect(current.proven).toBe(true)
    expect(current.outpointTxid).toBe(TXID)
    expect(current.outpointIndex).toBe(1)
    // A card the node holds only at another outpoint is refused by rule 2, whatever the listing says.
    const stale = fakeNode([
      deed('kaspa', TXID, 5),
      { address: vector.address, transactionId: 'cc'.repeat(32), index: 1 },
    ])
    const older = (await new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node: stale }).resolveName(
      'kaspa'
    ))!.card!
    expect(older.refusal).toMatch(/^rule 2:/)
    const deedless = fakeNode([{ address: vector.address, transactionId: TXID, index: 1 }])
    const noDeed = (await new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node: deedless }).resolveName(
      'kaspa'
    ))!.card!
    expect(noDeed.refusal).toMatch(/^rule 5:/)
    const proven = (await new Dotk({
      api: 'http://x',
      fetch: withCard(cardOut(vector)),
      node: fakeNode([deed('kaspa', TXID, 5), { address: vector.address, transactionId: TXID, index: 1 }]),
    }).resolveName('kaspa'))!.card!
    expect(proven.proven).toBe(true)
    expect('refusal' in proven).toBe(false)
  })

  it('refutes the card of a name the node does not hold', async () => {
    const node = fakeNode([{ address: vector.address, transactionId: TXID, index: 1 }])
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.proven).toBe(false)
    expect(found.card!.proven).toBe(false)
    expect(found.records).toEqual({})
  })

  it('refuses a node that reports no outpoints, only when a card has to be proven', async () => {
    const bare = fakeNode([{ address: deedOf('kaspa', 0).address, covenantId: COVENANT_ID }])
    await expect(
      new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector)), node: bare }).resolveName('kaspa')
    ).rejects.toThrow(NodeError)
    expect((await new Dotk({ api: 'http://x', fetch: withCard(), node: bare }).resolveName('kaspa'))!.proven).toBe(true)
  })

  it('refuses a card listed under another name', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector, TXID, { key: toHex(keyBytesOf('a')) })) })
    await expect(dotk.resolveName('kaspa')).rejects.toThrow(ApiError)
  })

  it('keeps a card whose blob does not decode, with null records', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector, TXID, { blob: 'ff' })) })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.card!.records).toBeNull()
    expect(found.records).toEqual({})
  })

  it('hashes the blob for the card state, and never adopts the listed recordsHash', async () => {
    // The card's address hashes from that state, so a listing whose hash the reader adopted
    // would send it to an address of the api's choosing. Taking the blob instead makes a
    // disagreeing listing derive an address the node holds nothing at, which is the honest
    // failure: rule 3 holds by construction rather than by a check that could be skipped.
    const lying = cardOut(vector, TXID, { recordsHash: 'ff'.repeat(32) })
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(lying) })
    const found = (await dotk.resolveName('kaspa'))!
    expect(found.card!.recordsHash).toBe(vector.recordsHash)
    expect(found.card!.address).toBe(vector.address)
    // The records still decode: nothing about the blob changed, only whose word the state took.
    expect(found.card!.records).not.toBeNull()
  })

  it('marks the primary name by display order when there is no node', async () => {
    const cards = [cardFor('kaspa', { primary: true }), cardFor('a', { primary: true })]
    const dotk = new Dotk({ api: 'http://x', fetch: listing(['kaspa', 'a'], cards) })
    const owned = await dotk.namesOf(schnorr.address!)
    expect(owned.map((n) => [n.name, n.primary, n.card !== null])).toEqual([
      ['a', true, true],
      ['kaspa', false, true],
    ])
    expect(await dotk.displayNameFor(schnorr.address!)).toBe('a.k')
  })

  it('marks the primary name by the newest deed when there is a node', async () => {
    const kaspa = cardFor('kaspa', { primary: true })
    const a = cardFor('a', { primary: true }, 'cc'.repeat(32))
    const node = fakeNode([
      deed('kaspa', TXID, 9),
      deed('a', 'cc'.repeat(32), 3),
      { address: kaspa.cardAddress, transactionId: TXID, index: 1 },
      { address: a.cardAddress, transactionId: 'cc'.repeat(32), index: 1 },
    ])
    const dotk = new Dotk({ api: 'http://x', fetch: listing(['kaspa', 'a'], [kaspa, a]), node })
    expect((await dotk.namesOf(schnorr.address!)).map((n) => [n.name, n.primary])).toEqual([
      ['a', false],
      ['kaspa', true],
    ])
    expect(await dotk.displayNameFor(schnorr.address!)).toBe('kaspa.k')
  })

  it('lets a refuted claimant lose, and falls back to the display convention', async () => {
    const kaspa = cardFor('kaspa', { primary: true })
    const node = fakeNode([
      deed('kaspa', 'bb'.repeat(32), 9),
      deed('a', 'cc'.repeat(32), 3),
      { address: kaspa.cardAddress, transactionId: TXID, index: 1 },
    ])
    const dotk = new Dotk({ api: 'http://x', fetch: listing(['kaspa', 'a'], [kaspa]), node })
    expect((await dotk.namesOf(schnorr.address!)).map((n) => n.primary)).toEqual([false, false])
    expect(await dotk.displayNameFor(schnorr.address!)).toBe('a.k')
  })

  it('lists the cards an address may sweep', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.endsWith(`/spenders/0/${schnorr.owner}/cards`)
        ? {
            status: 200,
            body: {
              spenderType: 0,
              spender: schnorr.owner,
              address: schnorr.address,
              cards: [cardOut(vector)],
              registryCovenantId: COVENANT_ID,
            },
          }
        : undefined
    )
    const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
    const cards = await dotk.cardsOf(schnorr.address!)
    expect(calls).toHaveLength(1)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ name: 'kaspa', address: vector.address, proven: null })
  })

  it('refuses to look up cards for a script address', async () => {
    const dotk = new Dotk({ api: 'http://x', fetch: fakeFetch(() => undefined).fetchFn })
    await expect(dotk.cardsOf(deedOf('kaspa', 0).address)).rejects.toThrow(ConfigError)
  })

  it('names a card by the key it was checked against, not by the name served with it', async () => {
    // The key is what a card commits to. A served name that hashes to another key is the api's
    // word about a card the key check has already settled, so it never reaches the answer.
    const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector, TXID, { name: 'microsoft' })) })
    expect((await dotk.resolveName('kaspa'))!.card).toMatchObject({ name: 'kaspa' })

    const spent = fakeFetch(() => ({
      status: 200,
      body: {
        spenderType: 0,
        spender: schnorr.owner,
        address: schnorr.address,
        cards: [cardOut(vector, TXID, { name: 'microsoft' }), cardOut(vector, TXID, { name: 'not a name' })],
        registryCovenantId: COVENANT_ID,
      },
    })).fetchFn
    // With no local name to check against, an unprovable one is dropped rather than repeated.
    const listed = await new Dotk({ api: 'http://x', fetch: spent }).cardsOf(schnorr.address!)
    expect(listed.map((c) => c.name)).toEqual([undefined, undefined])
  })

  /**
   * The three subname rules, end to end through the API and the node. Every answer here is a
   * claim by the parent's owner, so each case asserts the tag that says what the claim is
   * worth.
   */
  describe('subnames', () => {
    const PAYEE = vectors.subnameValue.find((v) => v.value !== undefined && v.ownerType === 0)!
    const prefix = new Dotk({ api: null }).prefix
    const payeeAddress = ownerAddress(prefix, 0, hex32(PAYEE.owner, 'owner'))!
    const subCard = cardFor('kaspa', { 'sub:bob': PAYEE.value! })
    const proving = (card: CardOut) =>
      fakeNode([deed('kaspa', TXID, 5), { address: card.cardAddress, transactionId: TXID, index: 1 }])

    it('reads the payee off a card the node proves', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard), node: proving(subCard) })
      const found = (await dotk.resolveSubname(' Bob.Kaspa.K '))!
      expect(found.kind).toBe('subname')
      expect(found.label).toBe('bob')
      expect(found.display).toBe('bob.kaspa.k')
      expect(found.payee).toBe(payeeAddress)
      // Absent rather than an undefined key, which `exactOptionalPropertyTypes` asks for.
      expect('fault' in found).toBe(false)
      // The parent's address and its proof are reachable only through `parent`.
      expect(found.parent.proven).toBe(true)
      expect(found.parent.address).toBe(schnorr.address)
      expect(await dotk.payeeFor('bob.kaspa.k')).toBe(payeeAddress)
    })

    it("takes the api's word with no node, and proves nothing", async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard) })
      const found = (await dotk.resolveSubname('bob.kaspa.k'))!
      expect(found.parent.proven).toBeNull()
      expect(found.payee).toBe(payeeAddress)
      expect(await dotk.payeeFor('bob.kaspa.k')).toBe(payeeAddress)
    })

    it('answers refuted for a card the node does not hold, and pays nobody', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard), node: fakeNode([deed('kaspa', TXID, 5)]) })
      const found = (await dotk.resolveSubname('bob.kaspa.k'))!
      expect(found.fault).toBe('refuted')
      expect(found.payee).toBeNull()
      const e = await dotk.payeeFor('bob.kaspa.k').catch((e: unknown) => e)
      expect(e).toBeInstanceOf(RefutedError)
      expect((e as RefutedError).refuted).toBe('card')
      expect((e as RefutedError).message).toMatch(/card/)
    })

    it('names the deed where that is what the node refutes', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard), node: fakeNode([]) })
      const e = await dotk.payeeFor('bob.kaspa.k').catch((e: unknown) => e)
      expect(e).toBeInstanceOf(RefutedError)
      expect((e as RefutedError).refuted).toBe('deed')
      expect((e as RefutedError).nameOf).toBe('kaspa')
      expect((e as RefutedError).deedAddress).toBe(deedOf('kaspa', 0).address)
    })

    it('answers no-card for a name the api lists no card for', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard() })
      expect((await dotk.resolveSubname('bob.kaspa.k'))!.fault).toBe('no-card')
      expect(await dotk.payeeFor('bob.kaspa.k')).toBeNull()
    })

    /**
     * The node's verdict outranks the API's listing. With the deed refuted, `no-card` would name
     * the API's silence and hide the one fact a payer has to act on.
     */
    it('answers refuted rather than no-card where the node refutes the deed', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(), node: fakeNode([]) })
      const found = (await dotk.resolveSubname('bob.kaspa.k'))!
      expect(found.parent.card).toBeNull()
      expect(found.fault).toBe('refuted')
      expect(found.payee).toBeNull()
      const e = await dotk.payeeFor('bob.kaspa.k').catch((e: unknown) => e)
      expect(e).toBeInstanceOf(RefutedError)
      expect((e as RefutedError).refuted).toBe('deed')
    })

    it('answers unreadable-card for a blob that is no record set', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(cardOut(vector, TXID, { blob: 'ff' })) })
      const found = (await dotk.resolveSubname('bob.kaspa.k'))!
      expect(found.fault).toBe('unreadable-card')
      expect(found.parent.card!.records).toBeNull()
    })

    /**
     * Rule 2 settles the owner scheme first. A covenant-held parent holds no card of its own, so
     * a reader that starts at the card answers `no-card` and names the wrong cause.
     */
    it('answers parent-in-covenant even where a card sits beside the deed', async () => {
      const held = fakeFetch(() => ({
        status: 200,
        body: { ...nameBody('kaspa', 4, covenantOwner.owner), card: subCard },
      })).fetchFn
      const found = (await new Dotk({ api: 'http://x', fetch: held }).resolveSubname('bob.kaspa.k'))!
      expect(found.fault).toBe('parent-in-covenant')
      expect(found.payee).toBeNull()
      expect(found.parent.card).not.toBeNull()

      // The ordinary covenant-held parent carries no card, and the cause is still the covenant.
      const bare = fakeFetch(() => ({ status: 200, body: nameBody('kaspa', 4, covenantOwner.owner) })).fetchFn
      const alone = (await new Dotk({ api: 'http://x', fetch: bare }).resolveSubname('bob.kaspa.k'))!
      expect(alone.parent.card).toBeNull()
      expect(alone.fault).toBe('parent-in-covenant')
    })

    it('answers no-such-label for a label the card does not carry', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard) })
      const found = (await dotk.resolveSubname('pay.kaspa.k'))!
      expect(found.fault).toBe('no-such-label')
      expect(found.payee).toBeNull()
      expect(await dotk.payeeFor('pay.kaspa.k')).toBeNull()
    })

    it("carries the value's own fault through to the answer", async () => {
      const text = cardFor('kaspa', { 'sub:bob': 'kaspa:qqq' })
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(text) })
      expect((await dotk.resolveSubname('bob.kaspa.k'))!.fault).toBe('not-bytes')
      expect(await dotk.payeeFor('bob.kaspa.k')).toBeNull()
    })

    it('answers null wherever resolve answers null for the parent', async () => {
      const none = fakeFetch(() => ({ status: 404, body: { code: 'not_found', error: 'not registered' } })).fetchFn
      const dotk = new Dotk({ api: 'http://x', fetch: none })
      expect(await dotk.resolveSubname('bob.free.k')).toBeNull()
      expect(await dotk.payeeFor('bob.free.k')).toBeNull()
    })

    it('needs the api, as resolve does', async () => {
      await expect(new Dotk({ api: null }).resolveSubname('bob.kaspa.k')).rejects.toThrow(ConfigError)
      await expect(new Dotk({ api: null }).payeeFor('bob.kaspa.k')).rejects.toThrow(ConfigError)
    })

    /** Neither call ever answers about the other's subject, so no caller can pay the wrong party. */
    it('keeps every name call refusing a subname, and payeeFor refusing a bare name', async () => {
      const dotk = new Dotk({ api: 'http://x', fetch: withCard(subCard) })
      await expect(dotk.addressFor('bob.kaspa.k')).rejects.toThrow(InvalidNameError)
      await expect(dotk.resolveName('bob.kaspa.k')).rejects.toThrow(InvalidNameError)
      await expect(dotk.resolveMany(['bob.kaspa.k'])).rejects.toThrow(InvalidNameError)
      await expect(dotk.available('bob.kaspa.k')).rejects.toThrow(InvalidNameError)
      expect(() => dotk.normalize('bob.kaspa.k')).toThrow(InvalidNameError)
      expect(() => dotk.display('bob.kaspa.k')).toThrow(InvalidNameError)
      // A bare name gets a tag of its own, because no label failed the label rule. The message
      // quotes the input as the call reads it, trimmed and lowercased.
      for (const call of [dotk.payeeFor(' Kaspa.K '), dotk.resolveSubname('kaspa')]) {
        const e = await call.catch((e: unknown) => e)
        expect(e).toBeInstanceOf(SubnameError)
        expect((e as SubnameError).tag).toBe('no-label')
      }
      await expect(dotk.payeeFor(' Kaspa.K ')).rejects.toThrow(
        /^"kaspa\.k" is a name and carries no label\. Call resolveName or addressFor for a name$/
      )
      // The name calls name the two that answer a subname, rather than a refused character.
      const subnameMessage =
        /^"bob\.kaspa\.k" is a subname, and this call answers a name\. Use resolveSubname or payeeFor$/
      await expect(dotk.addressFor('bob.kaspa.k')).rejects.toThrow(subnameMessage)
      // The canonical form, as the call read it, rather than whatever the caller typed.
      expect(() => dotk.normalize(' Bob.Kaspa.K ')).toThrow(subnameMessage)
    })

    it('classifies a typed subname, and names the parent as parent', () => {
      const dotk = new Dotk({ api: null })
      expect(dotk.classify(' Bob.Kaspa.K ')).toEqual({
        kind: 'subname',
        parent: 'kaspa',
        label: 'bob',
        display: 'bob.kaspa.k',
      })
      expect(dotk.classify('dev.team.kaspa.k')).toEqual({
        kind: 'subname',
        parent: 'kaspa',
        label: 'dev.team',
        display: 'dev.team.kaspa.k',
      })
      // A name keeps its own arm, and an input that names neither still says why.
      expect(dotk.classify('kaspa.k')).toEqual({ kind: 'name', name: 'kaspa', display: 'kaspa.k' })
      expect(dotk.classify('kaspa.k.k').kind).toBe('neither')
      expect(dotk.classify('bob.kaspa').kind).toBe('neither')
    })

    /**
     * `alice.k` is the common spelling of a name, so a typo in one is the common failure here.
     * Such an input carries no label, and the reason a field shows stays the name rule's own.
     * Rule 1's reason names the parent, which says nothing to whoever typed the name.
     *
     * Both calls read one helper, so one input gets one reason whichever the caller reached.
     */
    it('gives classify and normalize one reason for a dotted input that is no subname', () => {
      const dotk = new Dotk({ api: null })
      const classified = (input: string) => {
        const answer = dotk.classify(input)
        expect(answer.kind, input).toBe('neither')
        return answer.kind === 'neither' ? answer.reason : ''
      }
      const normalized = (input: string) => {
        try {
          dotk.normalize(input)
          return 'no fault'
        } catch (e) {
          expect(e, input).toBeInstanceOf(InvalidNameError)
          return (e as Error).message
        }
      }
      for (const [input, reason] of [
        // No dot survives the suffix, so the name rule is the reader that refused it.
        ['al!ce.k', 'allowed characters: a-z, 0-9 and hyphen'],
        ['z'.repeat(33) + '.k', 'name must be 1..=32 bytes on-chain'],
        ['.k', 'name must be 1..=32 bytes on-chain'],
        ['a-.k', 'name cannot start or end with a hyphen'],
        // A dot does survive, so rule 1 refused it and its message names the failing part.
        ['bob.alice', 'a dotted input must end in .k'],
        ['kaspa.com', 'a dotted input must end in .k'],
        ['a..k', 'the parent is empty'],
        ['kaspa.k.k', 'the parent "k" cannot carry a subname'],
        ['k.alice.k', 'the label part "k" breaks the label rule'],
      ] as const) {
        expect(classified(input), input).toBe(reason)
        expect(normalized(input), input).toBe(reason)
      }
    })

    /** The name calls send a caller to `resolveSubname` only where a subname is there. */
    it('names the subname calls for a subname, and for nothing else', () => {
      const dotk = new Dotk({ api: null })
      expect(() => dotk.normalize('bob.kaspa.k')).toThrow(/Use resolveSubname or payeeFor/)
      for (const input of ['kaspa.com', 'a.b', '1.2', 'a..k', 'kaspa.k.k']) {
        expect(() => dotk.normalize(input), input).toThrow(InvalidNameError)
        expect(() => dotk.normalize(input), input).not.toThrow(/is a subname/)
      }
    })
  })
  /**
   * One call for a send field. Every arm carries `address`, a subname's address is the parent
   * owner's entry, and a refutation throws as it does under `addressFor` and `payeeFor`.
   */
  describe('recipientFor', () => {
    const PAYEE = vectors.subnameValue.find((v) => v.value !== undefined && v.ownerType === 0)!
    const prefix = new Dotk({ api: null }).prefix
    const payeeAddress = ownerAddress(prefix, 0, hex32(PAYEE.owner, 'owner'))!
    const subCard = cardFor('kaspa', { 'sub:bob': PAYEE.value! })
    const proving = (card: CardOut) =>
      fakeNode([deed('kaspa', TXID, 5), { address: card.cardAddress, transactionId: TXID, index: 1 }])
    const notFound = () => ({ status: 404, body: { code: 'not_found', error: 'not registered' } })

    it('pays a typed address as it is, and asks nobody', async () => {
      const { fetchFn, calls } = fakeFetch(notFound)
      const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
      expect(await dotk.recipientFor(` ${schnorr.address} `)).toEqual({ kind: 'address', address: schnorr.address })
      expect(calls).toEqual([])
      expect(await new Dotk({ api: null }).recipientFor(schnorr.address!)).toMatchObject({ kind: 'address' })
    })

    it('pays a name at the address the chain proves, in one request and one probe', async () => {
      const { fetchFn, calls } = fakeFetch((url) =>
        url.endsWith('/names/kaspa')
          ? { status: 200, body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!) }
          : undefined
      )
      const node = fakeNode([deed('kaspa', TXID, 5)])
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).recipientFor(' Kaspa.K ')
      expect(r).toEqual({ kind: 'name', name: 'kaspa', display: 'kaspa.k', address: schnorr.address, proven: true })
      expect(calls).toHaveLength(1)
      expect(node.asked).toHaveLength(1)
      // Absent rather than an undefined key, which `exactOptionalPropertyTypes` asks for.
      expect('fault' in r).toBe(false)
    })

    it("takes the api's word for a name with no node, and proves nothing", async () => {
      const { fetchFn } = fakeFetch(() => ({ status: 200, body: nameBody('a', 0x85, ecdsa.owner, ecdsa.address!) }))
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn }).recipientFor('a')
      expect(r).toMatchObject({ kind: 'name', address: ecdsa.address, proven: null })
    })

    /** The API serves an ACTIVE registration or nothing, so the tag says what happened, not what the name is. */
    it('answers unresolved for a name the api serves nothing for, in one request and no probe', async () => {
      const { fetchFn, calls } = fakeFetch(notFound)
      const node = fakeNode([])
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).recipientFor('free')
      // `proven` is null with a node too: there is no deed to probe.
      expect(r).toEqual({
        kind: 'name',
        name: 'free',
        display: 'free.k',
        address: null,
        proven: null,
        fault: 'unresolved',
      })
      expect(calls).toHaveLength(1)
      expect(node.asked).toEqual([])
    })

    /** The node's verdict comes before the owner scheme, so a refuted covenant deed throws rather than answering. */
    it('answers in-covenant for a name a covenant holds, once the node agrees', async () => {
      const { fetchFn } = fakeFetch(() => ({ status: 200, body: nameBody('a-b9', 4, covenantOwner.owner) }))
      const held = fakeNode([{ ...deed('a-b9', TXID, 5), address: deedOf('a-b9', 4).address }])
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn, node: held }).recipientFor('a-b9')
      expect(r).toEqual({
        kind: 'name',
        name: 'a-b9',
        display: 'a-b9.k',
        address: null,
        proven: true,
        fault: 'in-covenant',
      })
      expect(await new Dotk({ api: 'http://x', fetch: fetchFn }).recipientFor('a-b9')).toMatchObject({
        fault: 'in-covenant',
        proven: null,
      })
      const e = await new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
        .recipientFor('a-b9')
        .catch((e: unknown) => e)
      expect(e).toBeInstanceOf(RefutedError)
      expect((e as RefutedError).refuted).toBe('deed')
    })

    it('throws where the node refutes the deed of a name, as addressFor does', async () => {
      const { fetchFn } = fakeFetch(() => ({
        status: 200,
        body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!),
      }))
      const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
      const e = await dotk.recipientFor('kaspa').catch((e: unknown) => e)
      expect(e).toBeInstanceOf(RefutedError)
      expect((e as RefutedError).refuted).toBe('deed')
      expect((e as RefutedError).nameOf).toBe('kaspa')
      await expect(dotk.addressFor('kaspa')).rejects.toThrow(RefutedError)
    })

    it("pays a subname at the parent owner's entry, with the parent's own answer beside it", async () => {
      const node = proving(subCard)
      const fetchFn = withCard(subCard)
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).recipientFor(' Bob.Kaspa.K ')
      expect(r).toMatchObject({ kind: 'subname', label: 'bob', display: 'bob.kaspa.k', address: payeeAddress })
      expect('fault' in r).toBe(false)
      // The parent's address and its proof sit under `parent`, and only there.
      expect(r.kind === 'subname' && 'proven' in r.parent && r.parent.proven).toBe(true)
      expect(r.kind === 'subname' && 'proven' in r.parent && r.parent.address).toBe(schnorr.address)
      expect(r.kind === 'subname' && r.parent.display).toBe('kaspa.k')
      expect('proven' in r).toBe(false)
      expect(node.asked).toHaveLength(1)
      expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
    })

    it("carries the entry's fault through, with no address", async () => {
      const text = cardFor('kaspa', { 'sub:bob': 'kaspa:qqq' })
      const r = await new Dotk({ api: 'http://x', fetch: withCard(text) }).recipientFor('bob.kaspa.k')
      expect(r).toMatchObject({ kind: 'subname', address: null, fault: 'not-bytes' })
      const missing = await new Dotk({ api: 'http://x', fetch: withCard(subCard) }).recipientFor('alice.kaspa.k')
      expect(missing).toMatchObject({ kind: 'subname', label: 'alice', address: null, fault: 'no-such-label' })
      const bare = await new Dotk({ api: 'http://x', fetch: withCard() }).recipientFor('bob.kaspa.k')
      expect(bare).toMatchObject({ kind: 'subname', address: null, fault: 'no-card' })
    })

    it('answers parent-in-covenant with the parent beside it', async () => {
      const { fetchFn } = fakeFetch(() => ({
        status: 200,
        body: { ...nameBody('kaspa', 4, covenantOwner.owner), card: subCard },
      }))
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn }).recipientFor('bob.kaspa.k')
      expect(r).toMatchObject({ kind: 'subname', address: null, fault: 'parent-in-covenant' })
      expect(r.kind === 'subname' && 'proven' in r.parent && r.parent.address).toBeNull()
    })

    it('answers parent-unresolved, with the parent named and nothing probed, in one request', async () => {
      const { fetchFn, calls } = fakeFetch(notFound)
      const node = fakeNode([])
      const r = await new Dotk({ api: 'http://x', fetch: fetchFn, node }).recipientFor('bob.Free.k')
      expect(r).toEqual({
        kind: 'subname',
        parent: { name: 'free', display: 'free.k' },
        label: 'bob',
        display: 'bob.free.k',
        address: null,
        fault: 'parent-unresolved',
      })
      expect(calls).toHaveLength(1)
      expect(node.asked).toEqual([])
    })

    it('throws where the node refutes the parent deed or its card, as payeeFor does', async () => {
      const deedOnly = fakeNode([deed('kaspa', TXID, 5)])
      const card = await new Dotk({ api: 'http://x', fetch: withCard(subCard), node: deedOnly })
        .recipientFor('bob.kaspa.k')
        .catch((e: unknown) => e)
      expect(card).toBeInstanceOf(RefutedError)
      expect((card as RefutedError).refuted).toBe('card')
      const deedGone = await new Dotk({ api: 'http://x', fetch: withCard(subCard), node: fakeNode([]) })
        .recipientFor('bob.kaspa.k')
        .catch((e: unknown) => e)
      expect(deedGone).toBeInstanceOf(RefutedError)
      expect((deedGone as RefutedError).refuted).toBe('deed')
    })

    /** Nothing a person can type throws, and nothing that names nothing costs a request. */
    it('answers neither, with a null address and the rule words, and asks nobody', async () => {
      const { fetchFn, calls } = fakeFetch(notFound)
      const dotk = new Dotk({ api: 'http://x', fetch: fetchFn, node: fakeNode([]) })
      for (const input of ['.k', 'alice.K', 'alice.k.k', 'k.alice.k', 'al ice', otherPrefix, '', '   ']) {
        const r = await dotk.recipientFor(input)
        expect(r.kind, input).toBe('neither')
        expect(r.address, input).toBeNull()
        expect(r.kind === 'neither' && r.reason, input).toBeTruthy()
      }
      for (const value of [undefined, null, 42, {}, []]) {
        const r = await dotk.recipientFor(value as string)
        expect(r.kind).toBe('neither')
        expect(r.address).toBeNull()
      }
      expect(calls).toEqual([])
    })

    it('passes the abort signal through on both arms', async () => {
      const { fetchFn } = fakeFetch(() => ({
        status: 200,
        body: nameBody('kaspa', 0, schnorr.owner, schnorr.address!),
      }))
      const controller = new AbortController()
      controller.abort()
      const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
      await expect(dotk.recipientFor('kaspa', { signal: controller.signal })).rejects.toThrow(/aborted/)
      await expect(dotk.recipientFor('bob.kaspa.k', { signal: controller.signal })).rejects.toThrow(/aborted/)
    })

    /** The README's recipient field, as written there, so `typecheck` compiles what the README shows. */
    it('runs the README example as written', async () => {
      const paid: [string, string][] = []
      const shown: string[] = []
      const pay = (address: string, caption = '') => paid.push([address, caption])
      const show = (why: string | undefined) => shown.push(why ?? '')
      const { fetchFn } = fakeFetch((url) =>
        url.endsWith('/names/kaspa')
          ? { status: 200, body: { ...nameBody('kaspa', 0, schnorr.owner, schnorr.address!), card: subCard } }
          : notFound()
      )
      const dotk = new Dotk({ api: 'http://x', fetch: fetchFn })
      const field = async (input: string): Promise<number> => {
        const r = await dotk.recipientFor(input)
        switch (r.kind) {
          case 'address':
            return pay(r.address)
          case 'name':
            return r.address ? pay(r.address) : show(r.fault)
          case 'subname':
            return r.address ? pay(r.address, `set by the owner of ${r.parent.display}`) : show(r.fault)
          case 'neither':
            return show(r.reason)
        }
      }
      for (const input of ['kaspa.k', 'bob.kaspa.k', schnorr.address!, 'free', 'nope.kaspa.k', 'bob.free.k', '.k']) {
        await field(input)
      }
      expect(paid).toEqual([
        [schnorr.address, ''],
        [payeeAddress, 'set by the owner of kaspa.k'],
        [schnorr.address, ''],
      ])
      expect(shown).toEqual(['unresolved', 'no-such-label', 'parent-unresolved', expect.stringMatching(/./)])
    })

    it('needs the api for a name or a subname, and not for an address', async () => {
      const dotk = new Dotk({ api: null })
      await expect(dotk.recipientFor('kaspa')).rejects.toThrow(ConfigError)
      await expect(dotk.recipientFor('bob.kaspa.k')).rejects.toThrow(ConfigError)
      expect((await dotk.recipientFor(schnorr.address!)).kind).toBe('address')
    })
  })
})
