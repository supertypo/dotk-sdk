import { ConfigError, TimeoutError } from './errors.js'

/** How many derivations run between two turns of the event loop. A few hundred is a few hundredths of a second. */
export const DERIVE_CHUNK = 250

/**
 * Give the event loop a turn, and stop here if the caller aborted. A long synchronous stretch,
 * such as deriving the addresses of thousands of names, is cut into chunks that yield through
 * this, so a deadline or a cancel takes effect between chunks and a screen keeps drawing.
 */
export function yieldNow(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason as Error)
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A deadline as given, made sure to be null or a positive number of milliseconds. A zero or a
 * NaN deadline fires at once or never, so it is refused rather than clamped.
 */
export function checkTimeout(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === null || timeoutMs === undefined) return null
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0))
    throw new ConfigError(`timeoutMs must be a positive number of milliseconds or null, not ${timeoutMs}`)
  return timeoutMs
}

/**
 * Run `work` under a deadline and the caller's signal. `work` gets a signal that fires when the
 * caller aborts or when the deadline passes, and the caller's promise settles at either, wherever
 * the work is.
 *
 * The race is here and not in an adapter because the wasm `RpcClient` takes no signal. A request
 * to a wedged node stays in flight whatever this does. With `null` there is no deadline, and a
 * `work` that ignores the signal settles when it settles, unless the caller cancels.
 *
 * @param what names the call in the timeout's message: "the api did not answer within 20000ms".
 */
export function withDeadline<T>(
  what: string,
  timeoutMs: number | null | undefined,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal | undefined) => Promise<T>
): Promise<T> {
  // A signal already aborted rejects the same way with a deadline and without one, so a caller
  // never meets a synchronous throw from one form and a rejection from the other.
  if (signal?.aborted) return Promise.reject(signal.reason as Error)

  const controller = new AbortController()
  const relay = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', relay, { once: true })
  const races: Promise<never>[] = []
  let cancel: (() => void) | undefined
  if (signal) {
    races.push(
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason as Error)
        signal.addEventListener('abort', cancel, { once: true })
      })
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  if (timeoutMs !== null && timeoutMs !== undefined) {
    races.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new TimeoutError(what, timeoutMs))
        }, timeoutMs)
      })
    )
  }

  // Started from a settled promise, so a `work` that throws before its first await still runs
  // the race and the cleanup below.
  const started = Promise.resolve().then(() => work(controller.signal))
  return Promise.race([started, ...races]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relay)
    if (cancel) signal?.removeEventListener('abort', cancel)
  })
}

/**
 * Run one task per item, at most `limit` at a time. The answers come back in the order the items
 * came in.
 *
 * The registry API has no batch read, so a screen listing many names is many requests. All of
 * them at once gets an integrator rate-limited, and one at a time takes a visible second to
 * fill.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const answers = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (let at = next++; at < items.length; at = next++) answers[at] = await task(items[at]!)
  })
  await Promise.all(workers)
  return answers
}

/**
 * {@link mapLimit} over the distinct items. It fills every slot the caller passed.
 *
 * A page of transaction history is the shape this is for: twenty rows paying one exchange
 * address cost one request. Repeats of an item share the same answer object.
 */
export async function mapLimitDistinct<T, R>(
  items: readonly T[],
  key: (item: T) => string,
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const first = new Map<string, number>()
  const distinct: T[] = []
  const slot = items.map((item) => {
    const k = key(item)
    const at = first.get(k)
    if (at !== undefined) return at
    first.set(k, distinct.length)
    distinct.push(item)
    return distinct.length - 1
  })
  const answers = await mapLimit(distinct, limit, task)
  return slot.map((at) => answers[at]!)
}
