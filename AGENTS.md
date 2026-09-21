# Contributor notes for @dotk/sdk

This is the read-only TypeScript client for the dotk name registry on Kaspa, published as
`@dotk/sdk`. This file holds the workflow and the rules that a change must not break. It does not
explain the package. [README.md](README.md) does that, for integrators.

This repository builds and tests standing alone. The maintainers also clone it inside a
workspace of their own, and that workspace holds the reference implementation, the generator of
everything under `src/generated/`, and the glossary this package's words come from. A contributor
outside it receives the generated inputs as reviewed files of this repository and cannot refresh
them. A change that needs them refreshed says so in its pull request, and a maintainer runs the
generator.

A clone standing alone runs the whole suite and packs a tarball of its own. The placeholder
check reads the tracked deployment manifests, which `DOTK_SDK_MANIFESTS` names, so a clone
without them packs with that check skipped and says so. A publish refuses without them.

One topic, one place. Describe only the current state. Never write "used to", "no longer", or
change history, in documentation or in code comments.

## What is generated, and committed

The maintainers generate everything under `src/generated/` from the reference implementation and
commit it here. Never edit one of these files by hand, and never write a new one here.

- `src/generated/<network>/genesis.ts` is a deployment manifest, one per registry this package can
  address. The package judges every answer by that identity.
- `src/generated/<network>/vectors.json` is the corpus, the conformance test vectors computed
  from that same manifest by the reference implementation. The tests replay the corpus, so the
  TypeScript can only agree with it or fail.
- `src/generated/openapi.json` is the API's own description of itself, one document for every
  deployment. `tests/contract.test.ts` measures `src/api.ts` against that document. A TypeScript
  type proves nothing at run time. A response field can leave the service while every read of it
  compiles. `fakeFetch` answers from those same interfaces. Without this document, the suite
  agrees with itself about a body that nothing sends.

All three are committed. They are text that a reviewer can diff. A manifest is the deployment
identity that the build carries, so a change of registry must be a visible diff. And a clone of
this repository alone runs the whole suite with no Rust toolchain.

The generator runs again whenever a deployment manifest, a derivation or the API's description
moves, and what changed is committed here. A corpus that nobody regenerated leaves the TypeScript
agreeing with a file that nothing recomputed. The five npm scripts cannot see that, and the
maintainers' own test can.

README.md states the selection rule an integrator sees. What a contributor keeps: the manifests
are static imports in `src/deployments.ts`, and that file decides what ships, never whatever a
build left under `generated/`. A manifest built for a local experiment therefore cannot reach a
release by sitting on a disk. The build files each registry under the network that its own
manifest declares, and puts that registry's corpus beside it. The templates that an address
derives through carry that deployment's params in their bytecode, so a second registry is a second
set of addresses. `tests/deployments.test.ts` replays every bundled registry.

The build produces a mainnet manifest once and never again. Do not point a script that refreshes
"the" manifest at a set that includes a mainnet one.

## The integrator's surface

README.md documents the `api` option, the per-network hosts and `DIRECTORIES`. What a contributor
must not break:

- An integrator sees the word "api", never "indexer".
- The API's names are canonical. An identifier that mirrors a wire field or a schema keeps the
  API's spelling, `neighbours` included, whatever the prose rule says. The API is a served
  contract and cannot change for this package. This package changes for the API.
- Every option that they can set lives in the constructor object. A new capability is a new
  method or a new optional field, never a changed signature.
- `dotk.name` is the web app and serves no API, so it is never a base anywhere.
- `Api.name` reads absence from the API's own `not_found` and never from the status, because a
  doubled version path answers every route with a 404.

This package carries no compiled code, no wasm and no Rust. It re-implements the pure derivations
in TypeScript: name normalization, state encoding, deed and gap addresses, and card codecs. The
corpus pins them wherever it has a section for them.

## Writing style

Documentation, code comments and user-facing strings follow the same rules. Prose that reads as
machine-written is a defect like any other. The rules below come from ASD-STE100, the controlled
English that aerospace writes its procedures in.

- Keep a sentence that tells the reader what to do under 20 words, and one that explains under 25.
  One instruction per sentence.
- Use simple tenses and the active voice. Write "the client sends", never "has sent" and never
  "is sent". Name the actor.
- Use only the modals can, will and must. A required "should" becomes "must". An optional one is
  deleted.
- Put a condition before its command, divided by a comma: "If the build fails, read the log."
- Write no semicolons and no em-dashes. Write two sentences, or name the relation with "because",
  "but" or "so".
- Keep complete grammar. No contractions, keep the articles, keep "that".
- One word, one meaning, for a whole file. Write `make sure that` for check, verify, confirm and
  ensure. Write `configuration` for config, settings and options.
- Break a noun chain longer than three words with a preposition.
- Define a concept term where it first appears, in under ten words. Do not define a product name,
  a standard name or the thing the file is about.
- State the fact, not its importance. Delete simply, seamlessly, robust, powerful, comprehensive,
  leverage, crucial, "in order to" and "it is worth noting".
- Use no bold lead-ins, no bold for emphasis and no emoji. A vertical list is for three or more
  parallel items.
- Capitals are for identifiers, never for emphasis. Protocol constants (`PENDING`, `ACTIVE`),
  acronyms and code names keep their case.
- Say a thing once, and vary the phrasing. A stock phrase repeated until it is a tic reads as
  filler.
- A contrast has to earn its negation. "X, not Y" is precise where Y is a real alternative that a
  reader assumes otherwise, and filler where it is not.
- Use one spelling per term, everywhere, and American spelling throughout. The covenant id is
  never abbreviated: "covenant id" in prose, `covenantId` in JSON.

### Comment shape

The rules above govern words. These govern what a comment is for and what it can point at.

- A comment states the fact and stops. Never add a sentence whose only job is to tell the reader
  that the fact matters. Where the consequence is not obvious, put it in the same sentence as the
  fact.
- Write nothing the signature already says. A comment that reads back the field names under it
  is a comment to delete.
- Write the shortest form that carries the fact. Three paragraphs over a forty-line file is a
  defect even where every sentence is true.
- Do not end a paragraph with a short fragment for rhythm.
- Do not count for effect. "Eleven tags reach this field" goes stale on the twelfth, and the list
  under it already says how many there are.
- Write what the code does, not what the code wants. An API returns an unusable body. It does not
  answer nonsense.
- Never name a closed-source project of this family, and never name a file, a path, a crate or a
  command inside one. That covers the parent workspace, the web app and the wasm bundle. Where a
  rule lives in one of them, state the rule here instead of pointing at it.
- An open-source project is fine to name, and naming one is usually more precise than not.
  `kaspanet/rusty-kaspa` and its crates, silverscript, Rust itself, a third-party wallet and a
  standard that defines a wire format (KIP-9, KIP-20, KCC-1, KCC-2, ENSIP-5, RFC 8949) all
  qualify, and so does a sibling package on npm.
- Never write history. No "used to", no "no longer", no "previously", and no note about what a
  change replaced or why the old way was wrong. A comment and a document describe the current
  state alone. `CHANGELOG.md` records what changed for an integrator, and a commit message
  records it for a contributor. Those two are the only places.

## Implementation workflow

1. Run `git pull` first, before you write anything. The remote can hold work from another machine
   or session. If you find that out at push time, you must do a needless merge.
2. Implement the change, with tests. If a change can regress behavior, write the regression test
   first. A change to a derivation starts in the reference implementation, then a regenerated
   corpus, then the TypeScript that replays it. A contributor without the generator writes the
   TypeScript and says in the pull request that the corpus needs regenerating.
3. Run the five, from the repository root. `npm ci` is the whole of the setup, with no Rust and no
   wasm.

```bash
npm run lint && npm run typecheck && npm run format:check && npm test && npm run build
```

4. Update the documentation that the change touches. Write what an integrator can see under a
   `## <next version>` heading in `CHANGELOG.md`.
5. Commit with a short message, on a feature branch, never on `main`. A mechanical reformat is its
   own commit, after the functional one. `main` is the branch a release is cut from, so work
   reaches it through a pull request that a maintainer merges.
6. Run `git push -u origin <your branch>`. Never leave finished work as local-only commits.

CI runs the five on every push and pull request, under `.github/workflows/ci.yml`. It runs them
after the fact, so the sequence above still runs before a push. The package is in production.

This repository commits its own `package-lock.json`. `@dotk/sdk-tx` depends on this package by
version range from the npm registry, so a change here reaches that one when this package is
published.

## The live test

`tests/live.test.ts` is the only thing that says this package agrees with a real deployment and
not only with the corpus. It reads through an API and never spends. It runs only when
`DOTK_LIVE_API` names one:

```bash
DOTK_LIVE_NETWORK=testnet-10 DOTK_LIVE_API=https://api-tn10.dotk.name npm test
```

When `DOTK_LIVE_NETWORK` is unset, the registry is mainnet. `DOTK_LIVE_NAME` names a registered
name on it, `sdktest` by default.

## Releasing

Release from the clone inside the parent workspace. First run `git pull` in both, then run the
generator as the parent workspace's notes describe, and get the five green. Then:

```bash
npm version <new> --no-git-tag-version
DOTK_SDK_MANIFESTS=<the directory of tracked manifests> npm publish
```

`files` packs `CHANGELOG.md`, so a bump with no entry under `## <new>` ships a stale record.
`prepack` runs `tools/check-release.mjs` and then builds, so a tarball never carries a stale
`dist` or none at all.

`prepublishOnly` runs the same gate with `--strict`. That mode refuses a publish where
`DOTK_SDK_MANIFESTS` names no directory holding `genesis.example.json` and every
`genesis.<network>.json`, so a release cannot skip the check by leaving the variable unset. The
gate refuses a bundled module built from the example manifest unless a tracked deployment for the
same network carries that registry too. It refuses outright with no registry listed in
`src/deployments.ts`. The parent workspace's notes say why the example needs that treatment.

Never publish around the gate. Commit the bump and push.

A major here moves `@dotk/sdk-tx`'s `package.json` too. `@dotk/sdk` appears there twice, once in
`peerDependencies` and once in `devDependencies`. Both ranges must allow the new version. If one
does not, an install resolves a nested second copy that breaks `instanceof DotkError`.
