// The read client against the deployment it is built for.
//
// Everything else in this suite answers from `fakeFetch` and the generated corpus, which proves
// this package agrees with the reference implementation and with the API's own description of
// itself. Neither says
// whether the service serves what that description promises, or whether a name this package
// derives an address for is the name the registry holds.
//
// Skipped unless `DOTK_LIVE_API` names an API serving the deployment the package is built
// against. It reads and never spends, so it needs no key and no node.

import { describe, expect, it } from 'vitest'
import { Dotk } from '../src/dotk.js'

const API = process.env['DOTK_LIVE_API']
// The registry the api serves; unset means the one an unqualified client gets (mainnet).
const NETWORK = process.env['DOTK_LIVE_NETWORK']
const NAME = process.env['DOTK_LIVE_NAME'] ?? 'sdktest'
const live = API ? describe : describe.skip

live('the read client against a real api', () => {
  const dotk = () => new Dotk({ api: API, network: NETWORK })

  it('answers for the registry it was built with', async () => {
    const status = await dotk().status()
    // An api serving another lineage is refused, which is what makes the rest of this worth
    // asserting.
    expect(status.sameRegistry).toBe(true)
    // An API that is merely behind says so through `caughtUp`, and that is lag rather than a failure.
    expect(status.healthy || !status.caughtUp).toBe(true)
    expect(status.active).toBeGreaterThan(0)
  })

  it('resolves a registered name to the address that holds it', async () => {
    const d = dotk()
    const resolved = await d.resolveName(NAME)
    expect(resolved).not.toBeNull()
    expect(resolved!.address!.startsWith(`${d.prefix}:`)).toBe(true)
    // `recipientFor` and `addressFor` are the recipient-field paths and must agree with the fuller answer.
    expect(await d.addressFor(NAME)).toBe(resolved!.address)
    expect((await d.recipientFor(NAME)).address).toBe(resolved!.address)
    // And the deed the package derives is where the registry says the name lives.
    // A covenant-owned name has no address to derive from, and this one is key-owned.
    expect(resolved!.address).not.toBeNull()
    expect(d.deedAddress(NAME, resolved!.address!)).toBe(resolved!.deedAddress)
  })

  it('names the address back', async () => {
    const d = dotk()
    const address = await d.addressFor(NAME)
    expect(address).not.toBeNull()
    const names = await d.namesOf(address!)
    expect(names.map((n) => n.name)).toContain(d.normalize(NAME))
    expect(await d.displayNameFor(address!)).toBe(d.display(NAME))
  })

  it('tells a registered name from a free one', async () => {
    const d = dotk()
    expect(await d.available(NAME)).toBe(false)
    expect((await d.lookup(NAME)).kind).toBe('active')
    const free = `sdkfree${Date.now().toString(36)}`
    expect(await d.available(free)).toBe(true)
    expect((await d.lookup(free)).kind).toBe('free')
    expect(await d.addressFor(free)).toBeNull()
  })

  it('serves the name’s history, newest first', async () => {
    const d = dotk()
    const history = await d.history(NAME)
    expect(history.entries.length).toBeGreaterThan(1)
    for (let i = 1; i < history.entries.length; i++) {
      expect(history.entries[i - 1]!.blueScore).toBeGreaterThanOrEqual(history.entries[i]!.blueScore)
    }
    // The oldest page holds the registration, whatever the name did since.
    const oldest = await d.history(NAME, { limit: 1, offset: history.total - 1 })
    expect(oldest.complete).toBe(true)
    expect(oldest.entries.map((e) => e.op)).toContain('register')
  })

  it('prices a registration the way the registry charges for it', async () => {
    const d = dotk()
    const quote = d.quote(NAME)
    expect(quote.fee).toBeGreaterThan(0)
    expect(quote.bond).toBe(d.params.bond)
    expect(quote.deposit).toBe(d.params.deposit)
  })
})
