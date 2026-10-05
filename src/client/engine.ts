// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  DipApiError,
  DipError,
  DipNetworkError,
  DipParseError,
  DipValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
  redactUrl,
} from "./errors.js";
import {
  assertHeaderValue,
  assertValid,
  headerNameProblem,
  intInRangeProblem,
  type Problem,
} from "./validate.js";

export const DEFAULT_BASE_URL = "https://search.dip.bundestag.de";

/** The API path the client appends to the base URL. */
export const API_PATH = "/api/v1";
/** The User-Agent sent when none is given (by the client and by `obtainKey`). */
export const DEFAULT_USER_AGENT = "dip-bundestag-cli";

/**
 * Escape raw C0 control characters (U+0000–U+001F) that appear *inside* JSON
 * string literals, rewriting each to its \uXXXX form. Structural whitespace
 * between tokens (the spaces/newlines a server may use to pretty-print) is left
 * untouched, since only control characters within a string are illegal.
 *
 * Walks the text with a minimal string-state machine that honours backslash
 * escapes, so an already-escaped quote (\") does not prematurely end a string.
 * Used to repair the occasional malformed record served by the DIP API before a
 * retried JSON.parse — see getJson.
 */
export function escapeRawControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let afterBackslash = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (afterBackslash) {
      out += ch;
      afterBackslash = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      afterBackslash = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (code <= 0x1f) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Strip control characters out of a string that originates in an
 * attacker-controlled HTTP response — the error `detail` and the echoed
 * Content-Type. JSON.parse decodes a backslash-u-001b escape in an error body
 * into a real ESC byte, so without this a hostile or MITM'd endpoint could drive
 * ANSI/OSC escape sequences into the user's terminal when the message is printed
 * to stderr. Removes all C0 (except tab/newline are kept implicitly by the range
 * choice below), DEL, and C1 control characters. The CLI's JSON output is escaped
 * separately (`escapeControlChars` in `cli/shared.ts`: `JSON.stringify` alone
 * leaves DEL and the C1 range raw), so this only needs to cover text that flows
 * into an error message.
 *
 * Implemented as an explicit char-code filter so no raw control byte ever appears
 * in this source file.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
  /** The URL that answered, after any redirects, without userinfo. */
  url: string;
  /**
   * Set when a redirect led to another origin (another scheme, host or port), so the
   * credentials (the API key, the base URL's userinfo) were not sent to the server
   * that answered: the origins before and after that hop.
   */
  credentialsDropped?: CredentialsDropped;
}

/** Where a redirect left the origin the credentials belong to. */
export interface CredentialsDropped {
  /** The origin that received the credentials. */
  from: string;
  /** The other origin the redirect led to, which did not. */
  to: string;
}

export interface EngineOptions {
  /**
   * Base URL of the API: the host (plus any mirror path prefix), **without**
   * `/api/v1`, which the client adds. Defaults to https://search.dip.bundestag.de.
   * Checked by `validateBaseUrl` (`baseUrlProblem`): a value that does not parse,
   * a scheme other than http(s), a query or fragment, surrounding whitespace,
   * whitespace or control characters inside, and a trailing `/api/v1` are a
   * `DipValidationError`.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /**
   * Value of the User-Agent header (default `DEFAULT_USER_AGENT`). A blank value,
   * a control character but tab, or a character above U+00FF is rejected with
   * `DipValidationError`.
   */
  userAgent?: string;
  /** Extra headers sent on every request (e.g. an API key); checked like `userAgent`. */
  defaultHeaders?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms, else
   * `DipValidationError`). Enforced by the engine for every transport: the
   * transport gets an AbortSignal that fires at the deadline.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`. An integer 0..`MAX_RETRIES` (10).
   */
  maxRetries?: number;
  /** Base backoff between retries in milliseconds (grows linearly); used without a Retry-After. */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a DipApiError naming the target. An integer 0..`MAX_REDIRECTS` (10).
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * A non-negative safe integer. Checked on the body of every transport.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a DipApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Default time limit per request (30 s); `timeoutMs: 0` disables it. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default cap on a response body (100 MiB); `maxResponseBytes: 0` disables it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Most retries `maxRetries` may ask for (the CLI's `--max-retries` bound). */
export const MAX_RETRIES = 10;

/** Most redirects `maxRedirects` may ask for. */
export const MAX_REDIRECTS = 10;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** The numeric limits an engine (or `obtainKey`) takes. */
export type EngineLimits = Pick<
  EngineOptions,
  "timeoutMs" | "maxRetries" | "retryDelayMs" | "maxRedirects" | "maxResponseBytes"
>;

const LIMIT_RANGES: ReadonlyArray<[keyof EngineLimits, number]> = [
  ["timeoutMs", MAX_TIMEOUT_MS],
  ["maxRetries", MAX_RETRIES],
  ["retryDelayMs", Number.MAX_SAFE_INTEGER],
  ["maxRedirects", MAX_REDIRECTS],
  ["maxResponseBytes", Number.MAX_SAFE_INTEGER],
];

/**
 * Check every limit that is set: `timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries`
 * 0..`MAX_RETRIES`, `maxRedirects` 0..`MAX_REDIRECTS`, `retryDelayMs` and
 * `maxResponseBytes` any non-negative safe integer. `undefined` keeps the
 * default and 0 keeps its documented meaning. A negative, fractional, `NaN` or
 * infinite value would otherwise silently disable the timeout or the size cap,
 * or retry without end. Throws `DipValidationError` (`Invalid maxRetries: ...`).
 */
export function validateLimits(limits: EngineLimits): void {
  for (const [name, max] of LIMIT_RANGES) {
    const value = limits[name];
    if (value !== undefined) assertValid(name, value, intInRangeProblem(0, max));
  }
}

/**
 * Why a configured base URL cannot be used, or `undefined`. Checked in this
 * order (the first problem is reported):
 *
 * - it must parse as an absolute URL;
 * - the scheme must be http(s). The default transport also gates the scheme per
 *   hop, but the engine is exported as a library and may be handed a custom
 *   transport that does no such check;
 * - no query or fragment: request paths are appended to the base URL as a
 *   string, so `http://h/?x=1` would request `/?x=1/api/v1/...` and `http://h/#f`
 *   would request `/`;
 * - a `%` in the user name or password must start a valid escape (`%25` for a
 *   literal one): the userinfo is decoded for the Authorization header;
 * - no surrounding whitespace and no whitespace or control character inside.
 *   `new URL()` trims the first and drops tab/CR/LF inside, but the engine
 *   appends paths to the raw string, so `"https://h "` would request
 *   `https://h /api/v1/...`;
 * - the path must not end in `/api/v1`, which the client appends itself
 *   (`/api/v1/api/v1/...` is a 404).
 *
 * The reason never echoes the value: a base URL may carry a password.
 */
export const baseUrlProblem: Problem<string> = (value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo for the Authorization header and throws "URI malformed"
  // for a "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    return "A base URL cannot contain whitespace or control characters.";
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith(API_PATH)) {
    // (url.origin carries no userinfo, so nothing secret is echoed.)
    const suggestion = `${url.origin}${path.slice(0, -API_PATH.length)}`;
    return (
      `Leave out ${API_PATH}: the base URL is the host, and the client adds ` +
      `${API_PATH} itself (try ${suggestion}).`
    );
  }
  return undefined;
};

/**
 * Why credentials would cross the network unencrypted, or `undefined`: the base URL
 * is plain `http:` to a host other than the loopback interface, and an API key or a
 * `user:password@` would be sent to it. Not an error (a mirror on a trusted network
 * is a legitimate setup), so the CLI prints it as a warning; a missing "s" is an easy
 * slip, and DIP itself only answers plain http with a redirect to https.
 */
export function cleartextCredentialsProblem(baseUrl: string, hasKey: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  if (!hasKey && !userinfo) return undefined;
  const what = hasKey && userinfo ? "The API key and the base URL's credentials are" : hasKey ? "The API key is" : "The base URL's credentials are";
  return `${what} sent unencrypted to ${url.host} (http:, not https:).`;
}

/**
 * Check a configured base URL (`baseUrlProblem`) and return it without trailing
 * slashes. Throws `DipValidationError` (`Invalid baseUrl: ...`): a bad base URL
 * is a configuration error, not a transport failure (`DipNetworkError` is kept
 * for the default transport's per-hop checks). Called by the `RequestEngine`
 * constructor (so `DipClient` and `obtainKey` too) on the raw value, before any
 * request.
 */
export function validateBaseUrl(raw: string): string {
  assertValid("baseUrl", raw, baseUrlProblem);
  return raw.replace(/\/+$/, "");
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) {
    return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  }
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. A string is read as UTF-8. Undefined for anything else.
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    return Buffer.from(value as ArrayBuffer);
  }
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names, as the engine reads
 * them. A transport built on `fetch` naturally returns its `Headers` object, which
 * passes as an object but has no plain properties: the engine then saw no
 * Retry-After and no Location at all. Such an object (anything with `get` and
 * `forEach`, a `Map` included) is copied into a record; a plain record gets its names
 * lower-cased (Node's transport does that already, a custom one may not).
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  const record: Record<string, string | string[] | undefined> = {};
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    (h.forEach as (cb: (value: string, name: string) => void) => void).call(headers, (value, name) => {
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** A single header value (the first of a repeated one), or undefined. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a failure caused by a reset or aborted connection (`ECONNRESET`, `EPIPE`,
 * `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the `cause` chain), which the
 * engine retries like a 503 — whichever transport raised it. A refused connection, a
 * DNS failure or a timeout is not transient in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return hasTransientCode(err);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Header names (lower-cased) that carry credentials and must never follow a
// redirect to a different origin.
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

/**
 * `url` without its userinfo, and the `Authorization: Basic` value the userinfo
 * stands for (undefined without one). The engine attaches credentials per hop
 * itself, so a transport never sees a URL with userinfo: Node's http would turn it
 * into a Basic header on every hop, and `fetch` refuses such a URL. A URL that does
 * not parse is returned as is, for the transport to report.
 */
function splitUserinfo(url: string): { url: string; basic: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, basic: undefined };
  }
  if (parsed.username === "" && parsed.password === "") return { url, basic: undefined };
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const pair = `${decode(parsed.username)}:${decode(parsed.password)}`;
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.href, basic: `Basic ${Buffer.from(pair, "latin1").toString("base64")}` };
}

/** The origin of `url` (scheme, host and port), or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Return a copy of `headers` with any credential-bearing header removed. */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL or
  // the API key in the default headers can't be logged by accident.
  readonly #baseUrl: string;
  readonly #defaultHeaders: Record<string, string>;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  /** Secrets without an `@` to anchor on (the API key), for the same scrubbing. */
  readonly #secrets: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    validateLimits(options);
    // Check the raw base URL here, not only in the default transport: a library
    // consumer that injects a custom transport would otherwise get no gating at
    // all, and could be steered to a non-http(s) scheme. Only `undefined`
    // selects the default.
    this.#baseUrl =
      options.baseUrl === undefined ? DEFAULT_BASE_URL : validateBaseUrl(options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only `undefined` selects the default; a blank or unsendable value is a
    // DipValidationError, as in the CLI's --user-agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertHeaderValue("userAgent", options.userAgent);
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertHeaderValue(`${name} header`, value);
    }
    // The secret part of a credential header (`ApiKey <key>` → the key), never echoed.
    this.#secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+/, "").trim());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws a `DipValidationError` for a path with a "." or ".." segment: URL
   * parsing would resolve it, so `/api/v1/vorgang/.` would request the list.
   * The resource methods already reject such an id (`idProblem`, message
   * `Invalid vorgang id: ...`); this is the backstop for callers of the engine.
   * (Percent-encoded forms such as "%2e%2e" are safe: encodeURIComponent turns
   * their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new DipValidationError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Perform a request with Accept negotiation, transient-error retries and
   * redirect following. `headers` are added to this request only (after the
   * default headers); credential headers among them are stripped on a
   * cross-origin redirect like the default ones.
   */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string; headers?: Record<string, string> } = {
      accept: "application/json",
    },
  ): Promise<RawResponse> {
    return this.send(method, this.buildUrl(path, options.query), options.accept, options.headers);
  }

  /**
   * GET an absolute URL (not under the base URL) with the same policy as every
   * other request: timeout, size cap, 429/503 retry with Retry-After, redirect
   * following with cross-origin credential stripping. A non-2xx answer throws
   * `DipApiError` (its `status` says which). `obtainKey` reads its key sources
   * with this.
   */
  async getAbsolute(
    url: string,
    options: { accept: string; headers?: Record<string, string> },
  ): Promise<RawResponse> {
    return this.send("GET", url, options.accept, options.headers);
  }

  /**
   * Send a request, following redirects and retrying transient failures.
   *
   * Credentials — the credential headers (`Authorization`, `X-API-Key`, `Cookie`) and
   * the start URL's userinfo, sent as `Authorization: Basic` unless an Authorization
   * header (the API key) is already set — are attached by the engine per hop, never
   * baked into the URL the transport sees. They go to the start URL's origin only:
   * a redirect to the same origin (a relative or an absolute `Location`) keeps them,
   * one to another scheme, host or port drops them for the rest of the chain, and the
   * result says so (`credentialsDropped`). The transport is told `redirect:
   * "manual"`; a transport that followed a redirect to another origin itself (its
   * response `url` says so) fails the request instead of being trusted.
   */
  private async send(
    method: string,
    startUrl: string,
    accept: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<RawResponse> {
    const all: Record<string, string> = {
      Accept: accept,
      "User-Agent": this.userAgent,
      ...this.#defaultHeaders,
      ...extraHeaders,
    };
    const plain = stripCredentialHeaders(all);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(all)) if (!(name in plain)) credentials[name] = value;
    const start = splitUserinfo(startUrl);
    if (start.basic !== undefined && !Object.keys(credentials).some((n) => n.toLowerCase() === "authorization")) {
      credentials["Authorization"] = start.basic;
    }
    const hasCredentials = Object.keys(credentials).length > 0;
    const credentialOrigin = originOf(start.url);
    let dropped: CredentialsDropped | undefined;
    let url = start.url;

    // Only an idempotent request is sent again: request() is public, and a POST re-sent
    // after a reset or a 503 may be applied twice. The client itself sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const sendCredentials = dropped === undefined && originOf(url) === credentialOrigin;
      const headers = sendCredentials ? { ...plain, ...credentials } : plain;
      let raw: HttpResponse;
      try {
        raw = await this.callTransport({
          method,
          url,
          headers,
          redirect: "manual",
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET like one, whichever transport reported it. Timeouts are
        // not retried — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        throw this.toNetworkError(method, url, cause);
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the DipError contract.
      const invalid = responseProblem(raw);
      if (invalid !== undefined) {
        throw new DipNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // A transport that followed a redirect itself (fetch's default) took the request
      // to a host the engine never checked, credential headers and all: fetch strips
      // Authorization across origins, but not X-API-Key or Cookie. Don't trust it.
      const reported = (raw as { url?: unknown }).url;
      if (typeof reported === "string" && reported !== "" && originOf(reported) !== originOf(url)) {
        throw new DipNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to ` +
            `${originOf(reported) ?? "an unparseable URL"}, another origin. A transport must not ` +
            `follow redirects (HttpRequest.redirect is "manual"); the engine follows them and ` +
            `decides where credentials may go.`,
        );
      }
      const status = raw.status;
      const responseHeaders = plainHeaders(raw.headers);
      const body = bodyBytes(raw.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new DipNetworkError(sizeLimitMessage(this.maxResponseBytes));
      }
      const response = { status, headers: responseHeaders, body };

      const retryable = status === 429 || status === 503;
      if (idempotent && retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL. Only an
      // http(s) target is followed: a file:, data: or javascript: one never reaches the
      // transport, and surfaces below as a DipApiError naming it.
      const location = headerValue(response.headers["location"]);
      const target = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      const next = target !== undefined && /^https?:$/.test(target.protocol) ? target : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, response.body, location, redirects || undefined, dropped);
      }
      if (next !== undefined) {
        // SECURITY: the credentials (`Authorization: ApiKey <key>`, the base URL's
        // userinfo as Basic, Cookie / X-API-Key) belong to the start URL's origin. A
        // redirect to another scheme, host or port drops them for the rest of the
        // chain — http→https on the same host included, as the key must not be
        // re-sent on a hop the user did not choose. A Location's own userinfo is
        // never used.
        next.username = "";
        next.password = "";
        if (hasCredentials && dropped === undefined && next.origin !== credentialOrigin) {
          dropped = { from: originOf(url) ?? "", to: next.origin };
        }
        url = next.href;
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a DipApiError naming the target.

      // Sanitize the server-supplied Content-Type at the source: it is
      // attacker-controlled and may later be echoed into a message.
      const contentType = sanitizeServerText(String(headerValue(response.headers["content-type"]) ?? ""));
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, location, undefined, dropped);
      }

      return {
        data: response.body,
        contentType,
        status,
        url,
        ...(dropped !== undefined ? { credentialsDropped: dropped } : {}),
      };
    }
  }

  /**
   * `text` without the base URL's credentials or the API key: server text (an error
   * body that echoes the request URL or its headers) and transport text (fetch's
   * "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return redactSecrets(redactCredentials(text, this.#credentials), this.#secrets);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original
   * when its text carries no secret, otherwise a copy with them scrubbed (message,
   * `code` and the cause chain kept), so logging the error with its causes can't
   * reveal the base URL's password or the key.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if ((this.#credentials.length === 0 && this.#secrets.length === 0) || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    const stack = cause.stack ?? "";
    if (message === cause.message && inner === cause.cause && this.scrub(stack) === stack) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Call the transport under the request's time limit (`timeoutMs`): the request gets
   * an AbortSignal that fires at the deadline, and the call rejects then whether the
   * transport stops or not — a custom transport (fetch, a node:http wrapper) that
   * ignores `timeoutMs` can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new DipNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A transport failure as a `DipNetworkError`. The default transport rejects with one
   * already (passed through); an injected one may throw anything (a TypeError from
   * fetch, a string, null), which is wrapped naming the request, with the original as
   * `cause`, so every failure stays a `DipError`.
   */
  private toNetworkError(method: string, url: string, cause: unknown): DipError {
    if (cause instanceof DipNetworkError) {
      // The built-in transport's own errors carry no URL; scrub anyway, in case a
      // custom transport built one from a server's text.
      const message = this.scrub(cause.message);
      const inner = this.scrubCause(cause.cause);
      if (message === cause.message && inner === cause.cause) return cause;
      return new DipNetworkError(message, inner === undefined ? undefined : { cause: inner });
    }
    if (cause instanceof DipError) return cause;
    const reason =
      cause instanceof Error && cause.message.trim() !== ""
        ? cause.message
        : typeof cause === "string" && cause.trim() !== ""
          ? cause
          : "the transport failed without a message";
    return new DipNetworkError(`${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}`, {
      cause: this.scrubCause(cause),
    });
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    // Every DIP endpoint answers with a JSON document (a list envelope or a
    // record), so an empty 2xx body (or 204 No Content) is a malformed response,
    // not `null`: printing `null` with exit 0 would let a script carry on.
    if (res.status === 204 || text.trim().length === 0) {
      throw new DipParseError(`Empty response body from ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // The DIP API occasionally serves a string value containing a raw,
      // unescaped C0 control character (e.g. a literal newline in a document
      // title). That violates the JSON grammar (RFC 8259 §7: U+0000–U+001F MUST
      // be escaped inside strings), so JSON.parse rejects it and a single
      // malformed record would otherwise sink the whole page. Repair those
      // characters and parse once more before giving up; the parsed value is
      // later re-serialised via JSON.stringify, so the rendered output (compact
      // or pretty) is always well-formed JSON.
      try {
        return JSON.parse(escapeRawControlCharsInStrings(text)) as T;
      } catch {
        throw new DipParseError(`Failed to parse JSON response from ${path}`, { cause });
      }
    }
  }

  /** Perform a GET returning the raw bytes (image / binary downloads). */
  async getRaw(path: string, accept: string, query?: QueryParams): Promise<RawResponse> {
    return this.request("GET", path, { query, accept });
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
    credentialsDropped?: CredentialsDropped,
  ): DipApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the (attacker-controlled) response body and flows into
    // DipApiError.message, which run.ts prints to stderr. Strip control
    // characters so a hostile endpoint cannot inject terminal escape sequences.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new DipApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(credentialsDropped !== undefined ? { credentialsDropped } : {}),
    });
  }
}

/** Resolve a Location header against the current URL; undefined if missing or malformed. */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
