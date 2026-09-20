// Refuse to publish a tarball whose bundled identity is a placeholder rather than a registry.
//
// `DOTK_SDK_MANIFESTS` names a directory of tracked deployment manifests: `genesis.example.json`
// beside one `genesis.<network>.json` per deployed registry. Where the variable names one, the
// gate reads those manifests and refuses a bundled module built from the example. Where it is
// unset, the gate says so and passes, which is what a clone packing a tarball of its own wants.
//
// `--strict` refuses to run at all without that directory, and `prepublishOnly` passes it. A
// release therefore cannot skip the check by leaving the variable unset, while `npm pack` works
// in any clone.
//
// The generator falls back to the example manifest where a clone has no manifest of its own,
// which is right for development and wrong for a release. The package judges every answer
// against the identity it was built with, so a tarball carrying a placeholder raises
// RegistryMismatchError on every call while the whole suite passes, because the corpus was
// written from that same example. Where the example is a copy of a live deployment, a module
// built from it for that network is that real registry and passes.
//
// One registry can be wrong while another is right, so every one the package carries is read,
// and the list comes from src/deployments.ts: what ships is what that file imports, not what a
// build happened to leave under generated/.
//
// What is compared is the registry each bundled module names, against the one the example
// manifest names. The example sits among the real deployments as a tracked file of the same
// shape, so the directory a module was built from says nothing a copy could not say too, while
// the covenant id is the identity itself.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const DEPLOYMENTS = join(here, 'src/deployments.ts')
const strict = process.argv.includes('--strict')
const manifests = process.env.DOTK_SDK_MANIFESTS ?? null

/** The registry a manifest, or a module written from one, declares. */
const covenantIdOf = (text) => /"registryCovenantId"\s*:\s*"([0-9a-fA-F]+)"/.exec(text)?.[1]

if (strict && manifests === null) {
  console.error(
    'sdk: DOTK_SDK_MANIFESTS is unset, and a release reads the tracked deployment manifests to ' +
      'tell a registry from the example placeholder. Set it to the directory that holds ' +
      'genesis.example.json and every genesis.<network>.json'
  )
  process.exit(1)
}

let example = null
if (manifests === null) {
  console.warn('sdk: DOTK_SDK_MANIFESTS is unset, so the placeholder check did not run')
} else {
  let text
  try {
    text = readFileSync(join(manifests, 'genesis.example.json'), 'utf8')
  } catch {
    console.error(
      `sdk: DOTK_SDK_MANIFESTS names ${manifests}, which holds no genesis.example.json, so no ` +
        'bundled registry can be told apart from a placeholder'
    )
    process.exit(1)
  }
  example = covenantIdOf(text)
  if (!example) {
    console.error('sdk: the example manifest names no registry, so no bundled one can be told apart from it')
    process.exit(1)
  }
}

let listing
try {
  listing = readFileSync(DEPLOYMENTS, 'utf8')
} catch {
  console.error('sdk: src/deployments.ts is missing, so this package addresses no registry at all')
  process.exit(1)
}

// Each bundled registry is a static import of its generated module, and the network is the
// directory that module sits in, which the generator names from the manifest itself.
const networks = [...listing.matchAll(/^import .+ from '\.\/generated\/([^/]+)\/genesis\.js'$/gm)].map((m) => m[1])

if (networks.length === 0) {
  console.error(
    'sdk: src/deployments.ts imports no manifest, so every call would answer for a registry ' +
      'this package does not carry. Run the generator, then list the registry here'
  )
  process.exit(1)
}

/** Whether a tracked manifest for this network is there and carries this registry. */
function deployed(network, covenantId) {
  if (manifests === null) return false
  try {
    return covenantIdOf(readFileSync(join(manifests, `genesis.${network}.json`), 'utf8')) === covenantId
  } catch {
    return false
  }
}

const failures = []
for (const network of networks) {
  const path = join(here, `src/generated/${network}/genesis.ts`)

  let module
  try {
    module = readFileSync(path, 'utf8')
  } catch {
    failures.push(`${network}: src/generated/${network}/genesis.ts is missing`)
    continue
  }

  const covenantId = covenantIdOf(module)
  if (!covenantId) {
    failures.push(`${network}: src/generated/${network}/genesis.ts names no registry at all`)
    continue
  }

  // The example is a verbatim copy of one live deployment's manifest, so its registry is a
  // real one wherever the tracked manifest for that network carries the same id. It is only a
  // placeholder, and refused, where no tracked deployment does.
  if (example !== null && covenantId === example && !deployed(network, covenantId)) {
    failures.push(`${network}: carries registry ${covenantId}, which is the example deployment's`)
    continue
  }

  console.log(`sdk: ${network} carries registry ${covenantId}`)
}

if (failures.length > 0) {
  console.error(
    `sdk: ${failures.join('; ')}. A package carrying one of these answers RegistryMismatchError ` +
      'to every call on that network. Deploy that network, or drop it from src/deployments.ts'
  )
  process.exit(1)
}
