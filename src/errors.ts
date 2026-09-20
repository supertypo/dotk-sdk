/** Base class of every error thrown on purpose. */
export class DotkError extends Error {
  override name = 'DotkError'
}

/** The input is not a name the registry can hold. `message` says why. */
export class InvalidNameError extends DotkError {
  override name = 'InvalidNameError'
}

/** The string is not a Kaspa address, or not one on the registry's network. */
export class InvalidAddressError extends DotkError {
  override name = 'InvalidAddressError'
}

/** The bundled manifest or the constructor options do not describe a usable registry. */
export class ConfigError extends DotkError {
  override name = 'ConfigError'
}

/**
 * Why the API refused, as the API spells it. Branch on this rather than on `detail`, which is
 * prose meant for a person and free to be reworded.
 */
export type ApiErrorCode =
  | 'invalid_name'
  | 'invalid_address'
  | 'invalid_key'
  | 'invalid_owner_type'
  | 'invalid_query'
  | 'not_found'
  | 'not_ready'
  | 'stale_proof'
  | 'internal'

/** The API answered with a status that is not an answer. */
export class ApiError extends DotkError {
  override name = 'ApiError'
  constructor(
    message: string,
    /** The HTTP status, or 0 when the request never got one. */
    readonly status: number,
    /** `error` from the response body, when it carried one. */
    readonly detail?: string | undefined,
    /**
     * `code` from the response body. The type is wider than the union because an API newer than
     * this package can name a code it does not know. A narrower type throws that code away.
     */
    readonly code?: (ApiErrorCode | (string & {})) | undefined,
    /** The error this one wraps, such as the transport's, where there is one. */
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
  }
}

/** The status of an answer the API delivered and this package could not use: it answered, and the body is what failed. */
export const ANSWERED = 200

/** The API serves a different registry than the client was built for. */
export class RegistryMismatchError extends ApiError {
  override name = 'RegistryMismatchError'
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`the API serves registry ${actual}, this package was built for ${expected}`, ANSWERED)
  }
}

/** The node call failed, or no node was configured for a call that needs one. */
export class NodeError extends DotkError {
  override name = 'NodeError'
}

/**
 * The input names no subname, or the stored entry names no payee.
 *
 * The subname calls and derivations throw it, and so does `checkPayload`, which judges a deed's
 * owner payload by the same tests. Branch on `tag`, which is a frozen vocabulary.
 * `message` is prose for a person.
 */
export class SubnameError extends DotkError {
  override name = 'SubnameError'
  constructor(
    message: string,
    /**
     * The fault tag. `no-suffix`, `bad-parent`, `bad-label` and `no-label` come from the typed
     * input. `parent-in-covenant`, `not-bytes`, `bad-length`, `bad-scheme`, `held-by-covenant`,
     * `zero-payload` and `not-a-point` come from the stored entry. Treat a tag this version
     * does not name as a refusal.
     */
    readonly tag: string
  ) {
    super(message)
  }
}

/**
 * The node does not hold what the API named: the deed of a name, or the card beside it.
 *
 * Only `Dotk.addressFor`, `Dotk.payeeFor` and `Dotk.recipientFor` throw it,
 * and only with a node configured, because those three answer the questions where a wrong
 * answer costs money. Everywhere else the same fact is the `proven: false` field.
 */
export class RefutedError extends DotkError {
  override name = 'RefutedError'
  constructor(
    /** The bare on-chain name. */
    readonly nameOf: string,
    /** The deed address the node was asked about. */
    readonly deedAddress: string,
    /** Which output the node refuted. A card refusal is a subname that pays nobody. */
    readonly refuted: 'deed' | 'card' = 'deed'
  ) {
    super(
      refuted === 'card'
        ? `the node refutes the card the API reports for ${nameOf}, whose deed is at ${deedAddress}`
        : `the node does not hold the deed the API reports for ${nameOf}, at ${deedAddress}`
    )
  }
}

/** A call did not finish inside `timeoutMs`. */
export class TimeoutError extends DotkError {
  override name = 'TimeoutError'
  constructor(what: string, ms: number) {
    super(`the ${what} did not answer within ${ms}ms`)
  }
}
