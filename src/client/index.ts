// Public entry point for the API client library.

export { DipClient } from "./client.js";
export type { DipClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { DipError, DipApiError, DipNetworkError, DipParseError } from "./errors.js";

export * from "./types.js";
