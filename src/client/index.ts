// Public entry point for the API client library.

export { DipClient } from "./client.js";
export type { DipClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, MAX_RETRY_AFTER_MS, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { obtainKey, API_KEY_ENV_VAR, KEY_SOURCE_URL } from "./obtain-key.js";
export type { ObtainKeyOptions, ObtainedKey } from "./obtain-key.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { DipError, DipApiError, DipNetworkError, DipParseError } from "./errors.js";

export * from "./types.js";
