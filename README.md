# @dotk/sdk

This package resolves `.k` names on Kaspa. It turns a name into an address, and an address into a
name. It also says whether a name is free. It only reads, and nothing here needs a wallet.

One call does what most integrators need. `recipientFor` takes whatever a person typed, a name, a
subname or an address, and answers the address to pay, or why there is none. The narrower calls
below it answer more about one kind of input, and a field reaches for them when it wants the
records behind a name, or to tell a free name from one still registering.

```bash
npm install @dotk/sdk
```

It runs on Node 22.12 or later, and in evergreen browsers. Its typings name `fetch` and
`AbortSignal`, so a TypeScript consumer compiles with the `DOM` library or `@types/node` in its
compiler configuration.

[examples/browser.html](examples/browser.html) runs the calls below against a live registry. Save
the file, open it in a browser, and press a button. It loads the published package from esm.sh, so
it needs no build and no wallet.

## A recipient field

```ts
import { Dotk } from '@dotk/sdk'

declare function pay(address: string, caption?: string): void
declare function show(why?: string): void // a tag from the table below, or the name rule's words

const dotk = new Dotk()
const r = await dotk.recipientFor(input) // never throws on the input

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
```

The answer is an arm for what the input is, each with `address` on it. An address pays itself. A
name pays the address the registry names for it, which a node has checked when `proven` is true,
or carries a `fault` when there is none. A subname pays the address the owner of the parent set
under the label, with the parent's own answer under `parent`, its proof included, so the field
captions the payee as that owner's entry. A subname whose parent is unresolved carries
`fault: 'parent-unresolved'`, and its `parent` keeps the name and the display form alone. A
non-null `address` tells those two subname shapes apart, and `'proven' in r.parent` tells their
two `parent` shapes apart, because `fault` is a string on both and narrows nothing. The rest is
`neither`, with the rule's own words in `reason`.

The tags a `Recipient` carries that no other answer does:

| Tag                 | On        | When                                                                                      |
| ------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `unresolved`        | a name    | the API serves no active registration: free, registering, owner unknown, or an API behind |
| `in-covenant`       | a name    | a covenant holds the name, and a covenant has no address to pay                           |
| `parent-unresolved` | a subname | the parent is `unresolved`, so there is no card to read                                   |

A subname carries the tags of the table under Subnames besides, except `refuted`, where
`recipientFor` throws `RefutedError` instead. `fault` is optional in the type and always set where
`address` is null, which is why `show` takes an optional string. A tag you do not know is a
refusal. `lookup` tells the first three causes of `unresolved` apart, and `status().caughtUp`
shows the fourth.

A wallet that pays no subnames answers the `subname` case with a refusal, such as
`case 'subname': return show('not supported')`, and never drops it, or that input gets no message
at all.

### The narrower calls

`recipientFor` runs `classify`, then `resolveName` for a name or `resolveSubname` for a subname.
Each narrower call is an alternative for a field that wants more about one kind of input.
`resolveName(name)` answers a name in full: the address, the proof, the records and the card.
`resolveSubname(subname)` answers a subname in full: the payee, the fault, and the parent's own
answer. `addressFor(name)` and `payeeFor(subname)` answer the address and nothing else, for code
that already knows what it holds. `classify(input)` sorts the input without asking the network,
and `lookup(name)` tells a free name from one still registering.

The same field by hand, for a wallet that wants `lookup`'s answer on a name that does not pay:

```ts
const typed = dotk.classify(input) // never throws

if (typed.kind === 'address') pay(typed.address)
else if (typed.kind === 'name') {
  const to = await dotk.addressFor(typed.name)
  if (to) pay(to)
  else show((await dotk.lookup(typed.name)).kind) // active under a covenant, pending, ownerUnknown, or free
} else if (typed.kind === 'subname') {
  const to = await dotk.payeeFor(typed.display) // `bob.alice.k`, set by the owner of `alice.k`
  if (to) pay(to)
  else show((await dotk.resolveSubname(typed.display))?.fault ?? 'parent-unresolved')
} else show(typed.reason)
```

`addressFor` answers `null` in two cases. Nobody owns the name, or a covenant owns it. A covenant
has no address to pay.

`lookup` says which case you have. It gives one of four answers:

- An ACTIVE name
- A name that is still registering
- A name whose owner the API cannot name right now
- A key that nobody holds

`available`, `resolveName` and `recipientFor` fold the middle two into their own answer. A field
that must not invite a payment into a half-finished registration therefore asks `lookup`.

## A name for an address

```ts
await dotk.displayNameFor('kaspatest:qz…') // 'kaspa.k', or null
await dotk.displayNamesFor([a, b]) // ['kaspa.k', null]
```

An address can own several names. The owner says which one they mean with a `primary` record,
described below. Where no owner says, this call picks one by convention. It takes the shortest
name, and it breaks a tie alphabetically.

`namesOf` lists every name in that order. It puts `primary: true` on the name that a card claims.
When no card claims one, it puts `false` on every name. Two cards can claim `primary` at once, and
then the node's order settles which one holds it. The newest deed wins, and the lower outpoint
breaks a tie. With no node to ask, the claim goes to whichever claimant comes first in the order
above.

`displayOrder` sorts a list that you built yourself.

Use these calls to show a name. To send value, go the other way, through `recipientFor` or
`addressFor`.

## Records

A name can carry records, such as a URL, an avatar, a GitHub handle and a `primary` flag. They live
in a card. A card is a small output that the owner's last transfer minted beside the deed. A name
holds one card, so its records reach you as a single map. `recipientFor` carries no records for a
name, and `resolveName` is the call for them:

```ts
const found = await dotk.resolveName('kaspa.k')
if (found) {
  found.records // { url: 'https://kaspa.org', 'com.github': 'kaspanet', primary: true }
  found.card // the card the API lists, with its own `records` and `proven`, or null
}
```

A key is an ENSIP-5 key where one fits, and free text otherwise. `RECORD_KEYS` names the ENSIP-5
keys. A value is a string, and `primary` alone is a boolean. A value that this version does not
recognize arrives as `{ opaque: '<hex>' }`, the exact bytes of one CBOR item. Keep that value, and
`encodeRecords` writes it back unchanged.

With a node, the client proves the card against the chain before its records count, and answers
`proven: true`. A card that the chain refutes leaves `records` empty. Without a node, `proven` is
null and you are taking the API's word. `cardsOf(address)` lists the cards that a key can reclaim.

### Subnames

A name's owner can point a label at an address. `bob.alice.k` is the label `bob` on the card of
`alice.k`, which is the subname's parent. The payee is the parent owner's claim, and the chain
proves none of it.

`recipientFor` answers a subname like any other input, with the payee under `address` and the
parent's own answer under `parent`:

```ts
const r = await dotk.recipientFor('bob.alice.k')
if (r.kind === 'subname' && r.address) {
  r.address // the payee, the entry of the owner of alice.k
  r.parent.proven // the node's word on alice.k, which is where a proof mark belongs
}
```

The narrower calls answer the same subname on its own:

```ts
await dotk.payeeFor('bob.alice.k') // the address to pay, or null

const found = await dotk.resolveSubname('bob.alice.k')
found?.payee // the same address, or null
found?.fault // why there is none, such as 'no-such-label'
found?.parent // the parent's own answer, with its address and its proof

dotk.classify('bob.alice.k') // { kind: 'subname', parent: 'alice', label: 'bob', display: 'bob.alice.k' }
```

Three rules decide a payee. Rule 1 splits the input: the client trims it, lowercases it, strips
one `.k`, and divides the rest at the last dot. Rule 2 finds the parent's card, and a node proves
it.
Rule 3 reads the label's value, which holds the owner scheme and a 32-byte payload.

Where a rule refuses, `fault` carries the tag and `payee` is null. `SubnameError.tag` carries the
same vocabulary for the faults that throw:

| Tag                  | When                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `no-suffix`          | a dotted input that does not end in `.k`                             |
| `bad-parent`         | the parent is not a name, or it is `k` under a label                 |
| `bad-label`          | a segment is not a name or is `k`, or the label is empty or too long |
| `no-label`           | `resolveSubname` or `payeeFor` on a bare name                        |
| `parent-in-covenant` | a covenant owns the parent, and a covenant claims nothing            |
| `no-card`            | the parent carries no card                                           |
| `unreadable-card`    | the card's blob is not a record set                                  |
| `no-such-label`      | the card carries no such label                                       |
| `refuted`            | the node refutes the parent's card or its deed                       |
| `not-bytes`          | the value is text, a flag, or an item that is not a byte string      |
| `bad-length`         | a byte string that is not the head `5821` over 33 bytes              |
| `bad-scheme`         | the scheme byte names no owner scheme                                |
| `held-by-covenant`   | the scheme byte is a covenant id, which nobody can pay               |
| `zero-payload`       | the payload is 32 zero bytes                                         |
| `not-a-point`        | a key scheme whose payload is not a point on the curve               |

On a `Subname`, `no-suffix`, `bad-parent`, `bad-label` and `no-label` throw, and the rest ride as
`fault`. The derivations below throw every tag they reach, `bad-label` included, and a `subnames`
row carries that one as its fault.
`refuted` covers the card and the deed alike, and `parent.proven` tells those two apart. A tag
from a newer version arrives as itself, so treat one you do not know as a refusal.

The three tags a `Recipient` adds are in the table under "A recipient field". They never ride on a
`Subname` and never throw as a `SubnameError`.

To build an editor or a listing, take the derivations too. `subnames(ownerType, records, prefix)`
is the listing every editor draws from. It answers every `sub:` entry of a card in key order, as
`{ label, address, fault? }`. That `address` is the payee of one row, and `Subname.payee` is the
payee of one lookup. A row that carries a `fault` carries `address: null` with it. `subnameOf`
answers one label. `subnameValue` writes the value for an owner pair, and `subnamePair` reads one
back. `subnameKey` builds the record key and holds the label rule.

Show a payee as somebody's entry and never as a fact. `alice.k` resolves to an address that the
chain proves. `bob.alice.k` resolves to an address that the owner of `alice.k` asserted. Put the
node's mark on the parent and never on the payee. Any name holder can point a label at anybody's
key, so never derive a subname from an address.

## Calls

A name argument can be what a person typed. The client trims whitespace and folds case, and `.k` is
optional. `" Kaspa.K "` and `kaspa` are therefore one name. An address must be on the registry's
network. Every call that reaches the network takes a last argument `{ signal }`. `recipientFor` is
the one call for a send field, and the rest each answer one kind of input.

| Call                         | Answer                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recipientFor(input)`        | what a typed string pays: `{ kind, address, fault?, … }`                                                                                                                  |
| `classify(input)`            | `{ kind: 'name' \| 'subname' \| 'address' \| 'neither', … }`                                                                                                              |
| `addressFor(name)`           | the address to pay, or null                                                                                                                                               |
| `payeeFor(subname)`          | the address a subname pays, or null                                                                                                                                       |
| `resolveName(name)`          | `{ address, proven, records, card, … }`, or null                                                                                                                          |
| `resolveMany(names)`         | `resolveName` for every name                                                                                                                                              |
| `resolveSubname(subname)`    | `{ parent, label, display, payee, fault, … }`, or null                                                                                                                    |
| `namesOf(address)`           | `[{ name, display, proven, primary, records, … }]`                                                                                                                        |
| `cardsOf(address)`           | the cards a key can sweep, live or retired                                                                                                                                |
| `namesOfMany(addresses)`     | `namesOf` for every address                                                                                                                                               |
| `displayNameFor(address)`    | the one name to show, or null                                                                                                                                             |
| `displayNamesFor(addresses)` | `displayNameFor` for every address                                                                                                                                        |
| `available(name)`            | whether the name can be registered now                                                                                                                                    |
| `availableMany(names)`       | `available` for every name                                                                                                                                                |
| `lookup(name)`               | `active` \| `pending` \| `ownerUnknown` \| `free`                                                                                                                         |
| `history(name, page?)`       | `{ entries, total, complete, … }`, newest first                                                                                                                           |
| `status()`                   | `{ sameRegistry, healthy, behind, active, … }`                                                                                                                            |
| `quote(name)`                | what registering costs, in sompi: `fee`, the tier paid to the devfund, `bond`, `deposit`, `gapValue`, `lockedValue` and `totalToFund`, which is what the wallet must hold |
| `verify(name, address)`      | whether the node holds that deed                                                                                                                                          |
| `verifyPending(name, addr)`  | whether the node holds that registration's PENDING deed                                                                                                                   |
| `normalize(input)`           | the bare on-chain name. An input that cannot be one throws                                                                                                                |
| `display(name)`              | how readers show it, `'kaspa.k'`                                                                                                                                          |
| `keyOf(name)`                | the name key, `blake3(name)`, hex                                                                                                                                         |
| `ownerOf(address)`           | `{ ownerType, owner }`, the record a deed stores                                                                                                                          |
| `deedAddress(name, address)` | the deed address for `name` under the owner `address`                                                                                                                     |
| `pendingDeedAddress(n, a)`   | where a registration of `n` by `a` sits before it completes                                                                                                               |
| `claimOf(name, address)`     | the claim that registration publishes, hex                                                                                                                                |

`resolveName` answers `address: null` for a name a covenant owns, and carries `ownerCovenantId`.

`addressFor` and `resolveName` take a name and refuse a subname. `payeeFor` and `resolveSubname`
take a subname and refuse a bare name. Neither pair ever answers about the other's subject, so no
caller can pay a parent's owner for a label. A name call refusing a subname names the two calls
that answer one. `recipientFor` takes either, and its `kind` says which one it answered about. Its
answer is not a `Classified`: on the subname arms `parent` is an object, and the parent's bare
name is `parent.name`.

A plural call answers an array as long as the one you passed, slot for slot, so `answers[i]`
belongs to your item `i`. Repeats cost one request instead of one request each, which is what
makes it affordable to name the counterparties of a page of history. Every list in one API
answer, the names or the cards of an address and the entries of a history page, is capped at
`MAX_LIST_ITEMS`, and an answer past it is an `ApiError`. A list of names or cards is derived
and judged in chunks of a few hundred that yield between them, so a screen keeps drawing. A
cancel or `timeoutMs` settles the call at once, and the work stops at its next chunk.

`history` is the one thing that a node cannot answer, so it comes from the API for every
configuration of the client. `complete` says whether the oldest entry held is the registration
itself.

Before you trust an API that you did not pick yourself, make sure that `status().sameRegistry` is
true. `caughtUp` says whether the API is level with the chain right now. When the API is not level,
`behind` says by how much. An API that fell behind answers "no such name" for a name that it has
not reached yet.

### Never fall back

If a name will not resolve, say so and stop. Do not send to a similar name, to a cached one, or to
the raw input. No failure mode here is worth a guess.

### Let `recipientFor` classify, or classify first

`recipientFor` classifies the input before it resolves anything, and its `subname` arm is already
resolved. With the narrower calls, call `classify` on the input first. If the user typed an
address, none of this is on the send path at all. `classify` tells you which one you got, and it
never throws.

With `classify`, a subname arrives as its own arm, and that arm names the parent as `parent`. Code
that handles `name` and `address` and treats the rest as neither refuses a subname, which is safe.
To support one, call `payeeFor` on the `subname` arm. `recipientFor` pays a subname unless the
caller tests `kind` first, so the choice is the caller's line, not the package's.

### Branch on `ApiError.code`, never on `detail`

Branch on the code. The Errors section below lists every one. Never branch on `detail`, which is
prose for a person and free to be reworded.

Owners change. If a screen needs it, cache a name that you are showing. Ask again every time before
you send.

Records are whatever the name's owner put there. `avatar` and `url` are arbitrary strings, and
`javascript:` and `data:text/html` are as valid in them as `https:`. Before you put one in an
`<img src>` or an `<a href>`, allow only the schemes that you mean to render.

This package reads and never writes. Nothing here builds, signs or sends a transaction, and it
needs no key. `quote` and `available` are here so that a flow can price a registration and make sure
that the name is free. The flow then hands the registration to whatever will make it, such as
`@dotk/sdk-tx`.

## What a node adds

Give the client a node, and the client proves every answer against the chain before you see it.
Without a node, an answer comes from the API, and you are taking the API's word.

| Call                                    | Without a node     | With a node                                                                                                                               |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `recipientFor(input)`                   | the API's answer   | a name's `proven` is `true` where there is a deed, a subname's proof is `parent.proven`, and a refuted deed or card throws `RefutedError` |
| `addressFor(name)`                      | the API's answer   | when the chain disagrees, throws `RefutedError`                                                                                           |
| `payeeFor(subname)`                     | the API's answer   | when the chain disagrees, throws `RefutedError`                                                                                           |
| `resolveSubname(subname)`               | the API's answer   | a refuted deed or card is `fault: 'refuted'`, no payee                                                                                    |
| `resolveName(name)`, `namesOf(address)` | `proven: null`     | `proven: true` or `false`                                                                                                                 |
| `displayNameFor(address)`               | any `primary` card | only a card the chain proves can claim                                                                                                    |
| `available(name)`                       | the API's answer   | `true` only once the chain agrees                                                                                                         |
| `verify(name, address)`                 | throws `NodeError` | `true` or `false`                                                                                                                         |

Nothing else changes. A client with no node is a normal way to use this package. Every call has
the same signature with a node and without one, so wiring one in changes no line of a caller's
code. Without a node, nothing is proven and nothing is refuted.

### Wiring one up

```ts
import { Dotk, fromWasm, fromWrpcJson, fromGrpc } from '@dotk/sdk'

const dotk = new Dotk({ node: fromWasm(() => rpcClient) })
```

```ts
fromWasm(() => rpcClient) // the wasm SDK's RpcClient, connected
fromWrpcJson((method, params) => jsonRpc.call(method, params)) // a JSON-RPC transport of your own
fromGrpc((request) => askOverTheStream(request)) // one request on kaspad's stream
```

- If your code replaces the client on reconnect, pass a function to `fromWasm`. The call then uses
  the current client, and not the one that was there at startup.
- Take the wasm SDK from a rusty-kaspa release, v2.0.0 or newer. The npm packages named `kaspa` and
  `kaspa-wasm` are 0.13.0 from 2023 and cannot prove anything. This package refuses a client that
  old with a `NodeError`, and does not answer `false` to everything.
- kaspad's gRPC service is one bidirectional stream, and it has no method to call. `fromGrpc`
  therefore takes the function that puts a request on that stream. That function waits for the
  response that carries `getUtxosByAddressesResponse`.
- The node needs `--utxoindex`.

Or pass anything shaped
`{ getUtxosByAddresses(addresses: string[], options?: { signal? }): Promise<Utxo[]> }`, where a
`Utxo` is `{ address, covenantId?, transactionId?, index?, daaScore? }`. `transactionId` and `index`
are the outpoint, and the client judges a card by it. A node that leaves them out still resolves
names. It throws `NodeError` where a card has to be proven. `daaScore` orders two cards that claim
`primary`, and a `daaScore` left out counts as zero. The bundled adapters fill all three fields.

## Options

```ts
new Dotk({
  api: 'https://api.dotk.name', // the base, without a version; `null` leaves only offline calls
  node: fromWasm(() => rpc), // no default
  timeoutMs: 20_000, // the default; `null` waits for ever
  concurrency: 6, // API requests in flight at once in a batch call
  network: 'testnet-10', // which bundled registry to address; see DEPLOYMENT_NETWORKS
  genesis: manifest, // a deployment this package does not carry, in place of one it does
  fetch: myFetch, // defaults to the global one
})
```

`api` is the base that the version segment hangs off. This package appends its own segment, so one
setting survives a version bump. Pass `https://api.dotk.name`, and not `https://api.dotk.name/v1`.
The constructor refuses the second one. It does not double the segment into a path that answers
nothing.

`api` defaults to the directory of whichever registry the client resolved to. There is one directory
per chain: `https://api.dotk.name` on mainnet and `https://api-tn10.dotk.name` on testnet-10.
`DIRECTORIES` lists them, and `directoryFor(network)` answers one. A registry that this package
carries without a public directory has no default, and the client says so. It does not borrow
another chain's host, because every answer from that host carries a covenant id that this client
refuses.

`network` chooses among the registries that this package carries a manifest for, which
`DEPLOYMENT_NETWORKS` lists. Every manifest is built in and none is fetched, so an API can never
supply the identity that you judge that same API by. Naming a network that the package does not
carry throws, because every address derived under it belongs to a registry that is not there.
Leave `network` out, and you get mainnet where this build carries it, and otherwise the single
registry that it does carry.

## Errors

Everything this package throws extends `DotkError`, with one exception: a call you cancel rejects
with the reason you aborted with, as you gave it. `recipientFor` never throws on its input, and
the one error a send field catches around it is `RefutedError`, which needs a node.

| Error                   | When                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `InvalidNameError`      | the input cannot be a name. `message` says why                                                                        |
| `InvalidAddressError`   | not an address, or not one on this network                                                                            |
| `RefutedError`          | the node refutes what the API named: a name's deed, a subname's parent deed, or the card the entry sits on            |
| `SubnameError`          | the input names no subname, the stored entry names no payee, or `checkPayload` refuses a deed owner. `tag` says which |
| `NodeError`             | the client cannot ask the node, or you gave no node                                                                   |
| `ApiError`              | the API refused or answered something unusable                                                                        |
| `RegistryMismatchError` | the API serves a different registry                                                                                   |
| `TimeoutError`          | the call outlived `timeoutMs`                                                                                         |
| `ConfigError`           | the options do not describe a usable registry, or a call needs the API and `api` is `null`                            |

`ApiError.code` is the API's own reason. The codes are `invalid_name`, `invalid_address`,
`invalid_key`, `invalid_owner_type`, `invalid_query`, `not_found`, `not_ready`, `stale_proof` and
`internal`. A code from a newer API arrives as itself. A refusal the API did not label, such as a
transport failure, carries no code at all.
