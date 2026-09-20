import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import openapi from '../src/generated/openapi.json' with { type: 'json' }

/**
 * `src/api.ts` is hand-written and is this package's only account of the shape the service
 * sends. TypeScript cannot notice when the two disagree, because the types are gone by run time
 * and `fakeFetch` is written from those same interfaces. Both sides then agree with each other
 * and with nothing else.
 *
 * This is the one place that reads the service's own description, `src/generated/openapi.json`.
 * The generator writes it, so it says what the handlers said as of the last run. Nothing here
 * invokes cargo, so a handler edited since then is one this check has not seen.
 */

/** The wire types, by the schema each one describes. `CallOptions` is ours and has no schema. */
const WIRE_TYPES = [
  'NameResponse',
  'OwnerResponse',
  'CardOut',
  'SpenderCardsResponse',
  'KeyResponse',
  'HealthResponse',
  'DeedOut',
  'GapOut',
  'NeighbourGaps',
  'HistoryEntry',
  'HistoryResponse',
  'KeyspaceTotals',
  'KeysByPrefix',
  'GapsByWidth',
  'DayCount',
  'BlockRef',
  'KeyspaceResponse',
] as const

interface Field {
  name: string
  optional: boolean
}

/**
 * The members of one response type, however it is spelled.
 *
 * An `extends` clause is refused rather than followed: the members it brings in are not listed
 * here, so following it halfway would check some of a type's fields and quietly ignore the rest.
 * Factoring a shared field out of any of them is an ordinary tidying, and it must not be the
 * thing that turns this check off.
 */
function declaredMembers(file: ts.SourceFile, name: string): ts.NodeArray<ts.TypeElement> {
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      if (statement.heritageClauses?.length) {
        throw new Error(`src/api.ts: ${name} inherits members this check cannot see; declare them here`)
      }
      return statement.members
    }
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      if (!ts.isTypeLiteralNode(statement.type)) {
        throw new Error(`src/api.ts: ${name} is composed from other types, which this check cannot read`)
      }
      return statement.type.members
    }
  }
  throw new Error(`src/api.ts declares no ${name}`)
}

/**
 * The fields one `export interface` declares, read with the compiler's own parser.
 *
 * TypeScript's parser rather than a regex, because every cheap approximation of one gets a
 * detail wrong in the direction that matters: a `readonly` modifier, a quoted key, a type
 * wrapped across lines, a brace inside a comment or a string. Each of those reads as "no field
 * here", and a check that quietly examines nothing reports success. Anything that is not a
 * plain property is refused by name instead of skipped.
 */
function declaredFields(source: string, name: string): Field[] {
  const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
  const members = declaredMembers(file, name)

  return members.map((member) => {
    if (!ts.isPropertySignature(member)) {
      throw new Error(`src/api.ts: ${name} has a member this check cannot read: ${member.getText(file)}`)
    }
    // A quoted key carries its quotes in the source and none of them on the wire.
    return { name: member.name.getText(file).replace(/^['"]|['"]$/g, ''), optional: member.questionToken !== undefined }
  })
}

const source = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
// Loosely typed on purpose: the document holds schemas this package never reads, and some of
// them compose with `allOf` rather than listing properties. Every type in `WIRE_TYPES` is flat,
// and is checked to be so rather than assumed.
type Schema = { properties?: Record<string, unknown>; required?: string[] }
const schemas = (openapi as { components: { schemas: Record<string, Schema> } }).components.schemas

describe('the response types match the service that serves them', () => {
  it.each(WIRE_TYPES)('%s', (name) => {
    const schema = schemas[name]
    if (!schema?.properties) throw new Error(`the API description has no flat schema ${name}`)
    const served = Object.keys(schema.properties)
    const required = new Set(schema.required ?? [])
    const declared = declaredFields(source, name)
    expect(declared.length, `${name} parsed as empty, so this check looked at nothing`).toBeGreaterThan(0)

    for (const field of declared) {
      // Declaring a field the service does not serve is the failure this exists to catch: every
      // read of it is `undefined` at run time and correct at compile time.
      expect(served, `${name}.${field.name} is declared here and served by nothing`).toContain(field.name)
      // A field the service may omit has to be optional here, or the first response without it
      // is a type that lied.
      if (!field.optional) {
        expect(required, `${name}.${field.name} is declared always present, and the service may omit it`).toContain(
          field.name
        )
      }
    }
  })

  /**
   * `ApiErrorCode` is the one type in this package whose whole value is being exhaustive: a
   * caller branches on it, so a member the service does not serve is a branch that never runs,
   * and a code the service serves and this omits is one a caller cannot name. The service
   * describes the set, so it decides it.
   */
  it('declares exactly the refusal codes the service serves', () => {
    const served = (schemas as unknown as { ErrorCode?: { enum?: string[] } }).ErrorCode?.enum
    if (!served) throw new Error('the API description has no ErrorCode enum')

    const errors = readFileSync(new URL('../src/errors.ts', import.meta.url), 'utf8')
    const file = ts.createSourceFile('errors.ts', errors, ts.ScriptTarget.Latest, true)
    const alias = file.statements.find(
      (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'ApiErrorCode'
    )
    if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error('src/errors.ts declares no ApiErrorCode union')
    // The union widens with `string & {}` so an unknown code from a newer service survives;
    // that member is deliberate and is not one of the codes.
    const declared = alias.type.types
      .filter((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
      .map((member) => ((member as ts.LiteralTypeNode).literal as ts.StringLiteral).text)

    expect(declared.length, 'the union parsed as empty, so this checked nothing').toBeGreaterThan(0)
    expect([...declared].sort()).toEqual([...served].sort())
  })

  // Declaring fewer fields than the service serves is allowed: this package reads what it needs
  // and ignores the rest, so the check above runs in one direction only. What that direction
  // cannot see is a response type nobody added to the list, so the list is held to the file.
  it('covers every response type the package declares', () => {
    const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
    const named = file.statements
      .filter(
        (s): s is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
          ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)
      )
      .map((s) => s.name.text)
      .filter((n) => n in schemas)
    expect(named.sort()).toEqual([...WIRE_TYPES].sort())
  })
})
