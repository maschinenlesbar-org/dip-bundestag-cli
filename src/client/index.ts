// Public entry point for the API client library.

export { DipClient } from "./client.js";
export type { DipClientOptions } from "./client.js";
export {
  RequestEngine,
  API_PATH,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  validateBaseUrl,
  validateLimits,
} from "./engine.js";
export type { EngineLimits, EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_SOURCE_URL } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { LIST_FILTERS } from "./filters.js";
export type { ListResource } from "./filters.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  DipError,
  DipApiError,
  DipNetworkError,
  DipParseError,
  DipUsageError,
  DipValidationError,
  redactUrl,
} from "./errors.js";
export {
  assertHeaderValue,
  assertNonBlankParams,
  assertValid,
  headerNameProblem,
  headerValueProblem,
  idProblem,
  intInRangeProblem,
  isBlank,
  nonEmptyProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
