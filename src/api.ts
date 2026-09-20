import { utf8 } from './bytes.js'
import { withDeadline, checkTimeout } from './deadline.js'
import { ApiError, ConfigError, RegistryMismatchError, type ApiErrorCode, ANSWERED } from './errors.js'
import type { Records } from './cards.js'
import type { Manifest } from './manifest.js'

/** `GET /names/{name}` */
export interface NameResponse {
  name: string
  ownerType: number
  owner: string
  address?: string | undefined
  deedAddress: string
  /**
   * The name's live card, where the name has one. A live card is output 1 of the transaction
   * that the deed's current UTXO came from, and it is unswept.
   */
  card?: CardOut | undefined
  registryCovenantId: string
}

/** `GET /owners/{ownerType}/{owner}` and `GET /addresses/{address}` */
export interface OwnerResponse {
  ownerType: number
  owner: string
  /** Absent for a covenant-id owner (`ownerType` 4), the one scheme with no address form. */
  address?: string | undefined
  names: string[]
  /** The live card of each of those names that has one. Every entry carries its `name`. */
  cards: CardOut[]
  registryCovenantId: string
}

/** One card as the index holds it, hex throughout. */
export interface CardOut {
  /** The bare name that the card's key is filed under. Absent only on a spender lookup where the key has no row. */
  name?: string | undefined
  key: string
  /** The minting transfer and the card's output index in it. The pair is the card's UTXO, while the card lives. */
  outpointTxid: string
  outpointIndex: number
  value: number
  /** The key that can sweep the card: a key-owned scheme byte, its payload, and its address. */
  spenderType: number
  spender: string
  spenderAddress: string
  /** The card's own P2SH address. The UTXO sits there, and the address is the anchor for rule 1. */
  cardAddress: string
  /** `blake3(blob)`, the hash the card's redeem script commits to. */
  recordsHash: string
  /** The record blob, hex, in deterministic CBOR. */
  blob: string
  /** The blob decoded, when it decodes. Absent for a blob that is not a record map. */
  records?: Records | undefined
  /**
   * Whether the card speaks for its name now. A live card is output 1 of the transaction that
   * the deed's current UTXO came from, and it is unswept. The field is always true on a name or
   * owner lookup. A spender lookup lists the retired cards too, which are the leftovers to sweep.
   */
  live: boolean
}

/** `GET /spenders/{spenderType}/{spender}/cards`: every unswept card that one key can sweep, live or retired. */
export interface SpenderCardsResponse {
  spenderType: number
  spender: string
  address: string
  cards: CardOut[]
  registryCovenantId: string
}

/** `GET /names/{name}/key` and `GET /keys/{key}` */
export interface KeyResponse {
  key: string
  kind: 'active' | 'pending' | 'ownerUnknown' | 'free'
  name?: string | undefined
  /** The key's own deed. Absent for a free key, and for one whose owner is unknown. */
  deed?: DeedOut | undefined
  /** `kind: "free"` only. This is the gap that a registration splits. */
  covering?: GapOut | undefined
  /** Occupied keys only. These are the two gaps that an exit co-spends. The field never appears with `covering`. */
  neighbours?: NeighbourGaps | undefined
  registryCovenantId: string
  /** Whether the last self-test proved this neighborhood. The field reports coverage, not freshness. */
  proven: boolean
  /** When that self-test finished, so a stale claim is visible rather than implied. */
  provenAt?: number | undefined
}

/** One gap's open interval, hex. */
export interface GapOut {
  lo: string
  hi: string
}

/** The two gaps that flank a live key. Each field name is the merge seat that its gap takes. */
export interface NeighbourGaps {
  predecessor: GapOut
  successor: GapOut
}

/**
 * One deed as the registry holds it, plus the address it lives at. That address also hashes from
 * `key` and the padded `name`, both on the enclosing {@link KeyResponse}. An ACTIVE deed carries
 * the owner pair, and a PENDING deed carries `claim`.
 */
export interface DeedOut {
  status: string
  /** ACTIVE only. */
  ownerType?: number | undefined
  owner?: string | undefined
  /** `P2SH(deed template ‖ the deed's state)`: the address to probe against a node. */
  deedAddress: string
  /** PENDING only: the claim hash that the split committed to. */
  claim?: string | undefined
  outpointTxid?: string | undefined
  outpointIndex?: number | undefined
  acceptedDaa?: number | undefined
}

/** One thing that happened to a key, and the deed that it left behind. */
export interface HistoryEntry {
  /**
   * `register` · `activate` · `transfer` · `release` · `evict` · `discover` · `sweep`. A
   * `sweep` is a card spent on its own. It takes a name's records away and leaves the deed
   * where it was.
   */
  op: string
  /** Apply order within the accepting block, so a reader reproduces the page's order. */
  seq: number
  blueScore: number
  daaScore: number
  blockTime: number
  blockHash: string
  txid: string
  /** The row's kind afterwards. Absent exactly when the deed ended here. */
  kind?: string | undefined
  name?: string | undefined
  ownerType?: number | undefined
  owner?: string | undefined
  claim?: string | undefined
  /**
   * What the event did to the name's card: `set`, `updated` or `deleted`. Absent where it left
   * the records alone.
   */
  cardChange?: string | undefined
}

/** `GET /keys/{key}/history`, newest first. */
export interface HistoryResponse {
  key: string
  /** How many entries this key has in all, so a caller pages without probing for the end. */
  total: number
  limit: number
  offset: number
  /** Whether the oldest entry held is the key's own registration. */
  complete: boolean
  entries: HistoryEntry[]
  registryCovenantId: string
}

/** Registry totals. The deed counts are the sums of `keysByPrefix`. */
export interface KeyspaceTotals {
  active: number
  pending: number
  ownerUnknown: number
  gaps: number
}

/** Where the registered keys fall: one bucket per leading key byte, so 256 of each. */
export interface KeysByPrefix {
  active: number[]
  pending: number[]
  ownerUnknown: number[]
}

/** How wide the gaps are, in quarters of the average gap. */
export interface GapsByWidth {
  counts: number[]
  bucketsPerAverage: number
  /** Gaps wider than the last bucket. This count stays out of `counts` because it is a different kind of value. */
  wider: number
}

/** One UTC day, `YYYY-MM-DD`, and how many names were registered on it. */
export interface DayCount {
  day: string
  count: number
}

/** The last chain block an answer is current to. */
export interface BlockRef {
  hash: string
  blueScore: number
  daaScore: number
  timestamp: number
}

/** `GET /keyspace`: the whole keyspace at a glance, cheap enough to poll. */
export interface KeyspaceResponse {
  registryCovenantId: string
  totals: KeyspaceTotals
  keysByPrefix: KeysByPrefix
  gapsByWidth: GapsByWidth
  /**
   * Registrations per UTC day, oldest first, and only the days that had one. The count comes
   * from the register events. A name released later still counts on the day of its registration.
   */
  registrationsByDay: DayCount[]
  /** The last processed chain block. The value is `null` until the API processes one. */
  lastBlock?: BlockRef | null | undefined
}

/** `GET /health`, with the same body on 200 and on 503. */
export interface HealthResponse {
  healthy: boolean
  /**
   * Whether the API is level with the chain right now. The test is that `lastBlock` is under
   * 10 s old and under 60 s of blocks behind `tipBlueScore` less `tipDistance`. The API computes
   * this on every answer and never latches it, so an API that reached the tip and then stalled
   * says `false` again. `healthy` tolerates 10 s of `false` before it follows.
   */
  caughtUp: boolean
  /** Confirmation depth that the fetch loop polls at, so this much distance is level rather than late. */
  tipDistance: number
  /** The last chain block processed, or `null` before the API processed its first. */
  lastBlock?: BlockRef | null | undefined
  /** The sink's blue score at the last observation, or `null` before the API makes one. */
  tipBlueScore?: number | null | undefined
  /** The network's nominal block rate, which turns a blue-score distance into seconds. */
  netBps: number
  /** Live ACTIVE names. The same number that `/keyspace` calls `totals.active`. */
  active: number
  pending: number
  /** Rows whose key is proven registered but whose owner is not yet named. These rows are the healing backlog. */
  ownerUnknown: number
  registryCovenantId: string
  network: string
}

export interface CallOptions {
  signal?: AbortSignal | undefined
}

/** The version segment every route hangs off. A caller gives the host, and {@link Api} appends this. */
export const API_VERSION_PATH = '/v1'

/**
 * The most bytes a single answer can occupy. A registry answer is small: the widest is an owner
 * holding a thousand names with a card apiece, which is a few megabytes. The cap is here because
 * the body arrives before anything has judged the service that sent it, and a client running
 * inside a wallet cannot buffer whatever that service hands it.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * The most items this package reads out of one list in an API answer: the names or the cards of
 * an address, and the entries of a history page. Each item costs a derivation, and with a node a
 * request, so the answer chooses how much work a call does. The cap bounds that choice.
 */
export const MAX_LIST_ITEMS = 10_000

/** What an `Api` is built with. A new capability is a new optional field here, never a changed signature. */
export interface ApiOptions {
  /** The API's base, without the version segment, which this class appends. */
  base: string
  /** The registry every lookup is checked against, as hex. */
  registryCovenantId: string
  /** The `fetch` to call, defaulting to the global one. */
  fetch?: typeof fetch | undefined
  /** How long one request can take, or null for no deadline. */
  timeoutMs?: number | null | undefined
}

/**
 * The registry API, asked with `fetch`. Every answer a lookup returns is checked against the
 * client's own registry. {@link genesis} and {@link health} are outside that check by design.
 */
export class Api {
  readonly base: string
  private readonly registryCovenantId: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number | null

  constructor(options: ApiOptions) {
    this.registryCovenantId = options.registryCovenantId
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args))
    this.timeoutMs = checkTimeout(options.timeoutMs)
    const base = options.base
    const host = base.replace(/\/+$/, '')
    // A base that already carries the version reaches `/v1/v1/…`, where every route answers a
    // bodiless 404. `name` reads absence from the API's own `not_found` and never from the
    // status, so such a base fails loudly here instead of emptying the registry.
    if (host.endsWith(API_VERSION_PATH))
      throw new ConfigError(
        `the api option is a base without a version segment. This package appends ` +
          `${API_VERSION_PATH} itself. Pass ${host.slice(0, -API_VERSION_PATH.length)}`
      )
    this.base = host + API_VERSION_PATH
  }

  /**
   * A name's owner, or undefined when the name is not ACTIVE. A registration still PENDING is
   * absent here too, and so is one whose owner the index cannot name. {@link nameKey} tells them
   * apart.
   *
   * Absence is the API saying `not_found`, never the status alone. A 404 also answers a base
   * that points somewhere else, and reading that as an unowned name is a confident wrong answer
   * on the one call that becomes a payment.
   */
  async name(name: string, options?: CallOptions): Promise<NameResponse | undefined> {
    return this.get<NameResponse>(`/names/${encodeURIComponent(name)}`, options, 'not_found')
  }

  async address(address: string, options?: CallOptions): Promise<OwnerResponse> {
    return (await this.get<OwnerResponse>(`/addresses/${encodeURIComponent(address)}`, options))!
  }

  async nameKey(name: string, options?: CallOptions): Promise<KeyResponse> {
    return (await this.get<KeyResponse>(`/names/${encodeURIComponent(name)}/key`, options))!
  }

  /**
   * A key's neighborhood, asked by key. A PENDING row carries no name until the registration
   * completes, so this is the only way to see one.
   */
  async key(key: string, options?: CallOptions): Promise<KeyResponse> {
    return (await this.get<KeyResponse>(`/keys/${encodeURIComponent(key)}`, options))!
  }

  /** Every live name that one owner holds, asked by the `(ownerType, owner)` pair that a deed stores. */
  async owner(ownerType: number, owner: string, options?: CallOptions): Promise<OwnerResponse> {
    return (await this.get<OwnerResponse>(`/owners/${ownerType}/${encodeURIComponent(owner)}`, options))!
  }

  /**
   * Every unswept card that a key can sweep, live or retired, asked by the `(spenderType, spender)` pair that a card
   * stores.
   */
  async spenderCards(spenderType: number, spender: string, options?: CallOptions): Promise<SpenderCardsResponse> {
    return (await this.get<SpenderCardsResponse>(
      `/spenders/${spenderType}/${encodeURIComponent(spender)}/cards`,
      options
    ))!
  }

  /** One key's history, newest first, a page at a time. `limit` is 1 to 100 and defaults to 5. */
  async history(key: string, page?: { limit?: number; offset?: number } & CallOptions): Promise<HistoryResponse> {
    const query = new URLSearchParams()
    if (page?.limit !== undefined) query.set('limit', String(page.limit))
    if (page?.offset !== undefined) query.set('offset', String(page.offset))
    const suffix = query.size > 0 ? `?${query}` : ''
    return (await this.get<HistoryResponse>(`/keys/${encodeURIComponent(key)}/history${suffix}`, page))!
  }

  /** The keyspace summary: the two distributions over it and what they add up to. */
  async keyspace(options?: CallOptions): Promise<KeyspaceResponse> {
    return (await this.get<KeyspaceResponse>('/keyspace', options))!
  }

  /**
   * The deployment manifest that this API booted from.
   *
   * A convenience, never a trust root. A client judges answers by its own bundled manifest, never
   * by one the same service supplied.
   */
  async genesis(options?: CallOptions): Promise<Manifest> {
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) => {
      const response = await this.fetch('/genesis', signal)
      if (!response.ok) throw await this.failure(response)
      return this.body<Manifest>(response)
    })
  }

  /** The health body, whether the API called itself healthy (200) or not (503). */
  async health(options?: CallOptions): Promise<HealthResponse> {
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) => {
      const response = await this.fetch('/health', signal)
      if (response.status !== ANSWERED && response.status !== 503) throw await this.failure(response)
      return this.body<HealthResponse>(response)
    })
  }

  private get<T extends { registryCovenantId: string }>(
    path: string,
    options: CallOptions | undefined,
    absent?: ApiErrorCode
  ): Promise<T | undefined> {
    return withDeadline('api', this.timeoutMs, options?.signal, async (signal) => {
      const response = await this.fetch(path, signal)
      if (!response.ok) {
        const failure = await this.failure(response)
        if (absent !== undefined && failure.code === absent) return undefined
        throw failure
      }
      const body = await this.body<T>(response)
      if (typeof body.registryCovenantId !== 'string')
        throw new ApiError('the API answered without a registry covenant id', ANSWERED)
      if (body.registryCovenantId.toLowerCase() !== this.registryCovenantId)
        throw new RegistryMismatchError(this.registryCovenantId, body.registryCovenantId)
      return body
    })
  }

  private async fetch(path: string, signal: AbortSignal | undefined): Promise<Response> {
    // `no-store` because this is a client of whatever API it was pointed at. An answer
    // about who owns a name is only worth what it was worth when the client asked for it. A
    // response with a long `max-age` otherwise outlives the reading of it in the caller's own
    // http cache, and no caller here chose that lifetime.
    const init: RequestInit = { headers: { accept: 'application/json' }, cache: 'no-store' }
    if (signal) init.signal = signal
    try {
      return await this.fetchFn(`${this.base}${path}`, init)
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ApiError(
        `this package failed to reach the API: ${e instanceof Error ? e.message : String(e)}`,
        0,
        undefined,
        undefined,
        e
      )
    }
  }

  /**
   * The parsed body, or an {@link ApiError} that names what arrived instead.
   *
   * A base URL pointing at something else returns a login page or a proxy's error page. Letting
   * `response.json()` throw hands the integrator a bare `SyntaxError` about an unexpected `<`,
   * which names neither the request nor the cause.
   */
  private async body<T>(response: Response): Promise<T> {
    const text = await this.text(response)
    try {
      return JSON.parse(text) as T
    } catch {
      const type = response.headers.get('content-type') ?? 'no content type'
      throw new ApiError(
        `the API answered ${response.status} with ${type}, which is not the JSON this call expects. ` +
          `Make sure that the api option points at a dotk registry API`,
        response.status
      )
    }
  }

  /**
   * The body as text, up to {@link MAX_BODY_BYTES}.
   *
   * `response.text()` buffers whatever arrives, and the service chooses what arrives. Reading a
   * chunk at a time abandons an oversized answer while it is still small.
   */
  private async text(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw this.tooLarge(response, declared)
    if (!response.body) {
      // A fetch with no stream, such as a polyfill, buffers the whole body. The cap still holds,
      // measured after the fact.
      const text = await response.text()
      // No code point takes fewer UTF-8 bytes than UTF-16 units, so a text over the cap by
      // units is over it by bytes, and the exact measure is taken only where the units allow it.
      if (text.length > MAX_BODY_BYTES) throw this.tooLarge(response, text.length)
      const size = utf8.encode(text).byteLength
      if (size > MAX_BODY_BYTES) throw this.tooLarge(response, size)
      return text
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) throw this.tooLarge(response, size)
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    // Joined by a loop rather than a spread. A body that arrives a byte at a time is more chunks
    // than one call can take as arguments.
    const out = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return new TextDecoder().decode(out)
  }

  private tooLarge(response: Response, size: number): ApiError {
    return new ApiError(
      `the API answered ${response.status} with at least ${size} bytes, past the ${MAX_BODY_BYTES} this call reads. ` +
        `Make sure that the api option points at a dotk registry API`,
      response.status
    )
  }

  private async failure(response: Response): Promise<ApiError> {
    let detail: string | undefined
    let code: string | undefined
    try {
      const body = JSON.parse(await this.text(response)) as { error?: string; code?: string }
      detail = body.error
      code = body.code
    } catch (e) {
      // Not a JSON body, so the status is the message. An oversized one is its own answer.
      if (e instanceof ApiError) return e
    }
    return new ApiError(
      `the API answered ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      detail,
      code
    )
  }
}
