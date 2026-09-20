# Changelog

The record starts at 1.2.0.

## 2.0.0

- `resolve` is renamed `resolveName`, so the two resolving calls read as a pair, `resolveName`
  beside `resolveSubname`. The old name is removed, with nothing forwarding from it.
- Two names say what they return or take: `names.keyBytesOf` for the key as bytes, beside
  `Dotk.keyOf` for the key as hex, and `ownerOfParsed` for the owner pair of a parsed address.
  `names.keyOf` and `ownerOfAddress` are removed.
- `Api`'s constructor takes one `ApiOptions` object. The positional form is removed.
- `classify` gains the arm `{ kind: 'subname', parent, label, display }`. A caller with an
  exhaustive switch over `Classified` must handle it. The parent is `parent` and never `name`, so
  code that pays `addressFor(c.name)` cannot pay a parent's owner for a label. Code that handles
  `name` and `address` and treats the rest as neither refuses a subname, which is the safe
  default. A dotted input that names a subname, and that 1.2.0 answered `neither` for, now answers
  the new arm. Code with an `else show(typed.reason)` branch must handle it. `addressFor`,
  `resolveName` and every other name call still refuse a subname, and their message names
  `resolveSubname` and `payeeFor`. Every other dotted input keeps the name rule's own reason, and
  `classify` and `normalize` now give one input one reason.
- `RefutedError` covers a refuted card as well as a refuted deed. The new third field `refuted`
  says which, and it is `'deed'` for every case that threw this error before.
- The package runs on Node 22.12 or later, and on evergreen browsers. Node 20 is out of the
  `engines` range, because it reached its end of life. `package.json` is exported for tooling
  that reads it.
- A card the API lists at a stale outpoint proves where the node holds the card at output 1 of
  the deed's own transaction, which is what rule 2 names. Such a card answered `proven: false`
  with empty `records` before, and it now carries the outpoint the node holds it at, its records
  count, and it can claim `primary`. A node client that reports a UTXO at a card's address with
  no outpoint is refused with `NodeError` where it was read as a refuted card.
- Three refusals of input that was wrong. `decodeAddress` and `encodeAddress` refuse a network
  prefix that is not one of the four Kaspa networks', which `NETWORK_PREFIXES` lists and the
  `NetworkPrefix` type names, where rusty-kaspa does. `encodeRecords` refuses a lone surrogate,
  which it wrote as U+FFFD. `timeoutMs` must be a positive number of milliseconds or null, on
  `Dotk` and on `Api` alike. A `genesis` manifest that misses its templates, its hashes or its
  network is a `ConfigError` rather than a crash. A name with a long interior run of whitespace
  is classified in linear time.
- `MAX_LIST_ITEMS` caps every list this package reads out of one API answer, the names or the
  cards of an address and the entries of a history page, at 10,000. An answer past the cap is an
  `ApiError` before any of it is derived or probed. A list of names or cards is derived and
  judged in chunks of a few hundred that yield between them, so a screen keeps drawing, and a
  cancel settles the call at once wherever the work is, as the deadline does. The
  same cap on the body size now holds for a `fetch` that gives no stream, such as a polyfill, and
  a body that arrives a byte at a time is read in bounded stack. An answer whose registry
  covenant id is not text is an `ApiError` rather than a crash, and `status()` reads it as
  another registry.
- `PROBE_CHUNK` is 400 addresses per `getUtxosByAddresses` call. A node answers a batch one address
  at a time, and it holds its utxoindex read lock for the whole call. A wide chunk therefore stalls
  that node's index updates for as long as the call runs. 400 keeps every lock hold short, and it
  is the widest this project has evidence for. A scan of many addresses now sends more requests,
  and each one is narrower.
- `recipientFor(input)` answers what a typed string pays, or why it pays nothing, in one call for
  a send field. It runs `classify` and then `resolveName` or `resolveSubname`, at most one API
  request for any input, and answers a `Recipient`: an address, a name with its address, a
  subname with its payee under `address` and the parent's answer under `parent`, or `neither`.
  The arms are `RecipientAddress`, `RecipientName`, `RecipientSubname`,
  `RecipientSubnameUnresolved` and `RecipientNeither`. A `Recipient` is not a `Classified`: on
  the subname arms `parent` is the parent's own answer rather than its bare name. Three tags ride
  on it alone, `unresolved`, `in-covenant` and `parent-unresolved`, outside the `Subname`
  vocabulary. It throws `RefutedError` where `addressFor` and `payeeFor` do. The four arms of
  `Classified` are named and exported, as type aliases: `ClassifiedName`, `ClassifiedSubname`,
  `ClassifiedAddress` and `ClassifiedNeither`, and `Classified` is their union as before.
- The client resolves a subname, which is a label a name's owner points at an address.
  `bob.alice.k` is the label `bob` on the card of `alice.k`. `resolveSubname(input)` answers a
  `Subname`, or `null` where the parent resolves to nothing. A `Subname` carries the parent's own
  answer under `parent`, the `payee`, and a `fault` tag where there is no payee. `payeeFor(input)`
  answers the address to pay, or null. Both need the API, and with a node a payee comes only off a
  card the chain proves. A payee is the parent owner's claim, and the chain proves none of it.
- The package exports the subname derivations that a writer and an editor need: `SUBNAME_PREFIX`,
  `subnameKey`, `subnameValue`, `subnamePair`, `subnameOf` and `subnames`. It exports
  `checkPayload`, the curve and zero tests an owner payload passes, and `names.LABEL_MAX`,
  `names.validateLabel` and `names.splitSubname`. `@noble/curves` joins the dependencies for the
  curve test.
- `SubnameError` is the new error. Branch on its `tag`, which is the frozen fault vocabulary.
- `ApiError` carries `cause` where it wraps the transport's own error, and `Card` carries
  `refusal`, the rule's own words, where the node refutes a card.
- Three shapes gain a name. `SubnameEntry` is the row `subnames` answers. `OwnerBytes` is the
  owner pair with its payload as bytes, which `subnamePair` and `ownerOfParsed` answer.
  `ApiOptions` is what `Api`'s constructor takes. `lessThan` on bytes is exported.
  Every optional property on an answer is spelled `?: T | undefined`, so a value read off one
  answer forwards into another under `exactOptionalPropertyTypes`. `withDeadline` rejects for a
  signal already aborted, with a deadline and without one alike, and it settles at the caller's
  cancel wherever the work is, as it settles at the deadline. A `work` that throws before its
  first await rejects the call as one that rejects, so a `try` around `withDeadline` catches
  nothing synchronously.
- The package exports `DayCount`, the element type of `KeyspaceResponse.registrationsByDay`.

## 1.2.0

- `RecordValue` widens to `string | boolean | { opaque: string }`. The codec carries a value that it
  does not recognize as the exact bytes of one CBOR item. The whole blob stays decodable. Handle a
  value that is neither a string nor a boolean by keeping it. A `const u: string = records.url` that
  assumed the narrow union stops compiling. A blob that threw before now decodes. The package
  exports `RECORD_DEPTH_MAX` beside `CARD_BLOB_MAX`.
