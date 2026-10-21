// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { constants } from "node:buffer";
import { TextDecoder } from "node:util";
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
  cutForMessage,
  echoedCredentialForms,
} from "./errors.js";
import {
  assertHeaderValue,
  assertValid,
  headerNameProblem,
  intInRangeProblem,
  isPlainObject,
  type Problem,
} from "./validate.js";

export const DEFAULT_BASE_URL = "https://search.dip.bundestag.de";

/** The API path the client appends to the base URL. */
export const API_PATH = "/api/v1";
/** The User-Agent sent when none is given (by the client and by `obtainKey`). */
export const DEFAULT_USER_AGENT = "dip-bundestag-cli";

/**
 * Parse a JSON body. The DIP API occasionally serves a string value containing a raw,
 * unescaped C0 control character (e.g. a literal newline in a document title). That
 * violates the JSON grammar (RFC 8259 §7: U+0000–U+001F MUST be escaped inside strings),
 * so JSON.parse rejects it and a single malformed record would otherwise sink the whole
 * page. Repair those characters and parse once more before giving up; the parsed value is
 * later re-serialised via JSON.stringify, so the rendered output (compact or pretty) is
 * always well-formed JSON.
 */
function parseJsonBody<T>(text: string, request: string, contentType: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    try {
      return JSON.parse(escapeRawControlCharsInStrings(text)) as T;
    } catch {
      // An HTML maintenance or proxy page is the usual non-JSON answer: name its type, so it
      // reads as an upstream problem rather than a client bug.
      const type = sanitizeServerText(contentType.split(";")[0]?.trim() ?? "");
      const hint = type !== "" && !/json/i.test(type) ? ` (expected JSON, got Content-Type "${cutForMessage(type)}")` : "";
      throw new DipParseError(`${request}: the answer is not valid JSON${hint}.`, { cause });
    }
  }
}

/** A JSON number token, matched at a given position (sticky). */
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The smallest positive normal double, 2^-1022. Below it a double has fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/**
 * Whether the double `value` (finite) prints as the number `literal` wrote, checked where a
 * double can be off in its leading digits: past 2^53, where every double is an integer, at 0,
 * which a literal too small for a double becomes, and below the smallest normal double, where a
 * subnormal has fewer significant digits (`3e-324` becomes `5e-324`). There the CLI prints
 * `String(value)`, the shortest decimal that reads back as the same double: `12345678901234567890`
 * prints as `12345678901234567000`, a changed value, while `1E23`, `1.7976931348623157E308` or
 * `5e-324` (a double a server printed in its own shortest form) print as the same number.
 */
function exactAtTheEdges(literal: string, value: number): boolean {
  const size = Math.abs(value);
  if (value !== 0 && size <= Number.MAX_SAFE_INTEGER && size >= MIN_NORMAL) return true;
  const written = decimalOf(literal);
  if (value === 0) return written.digits === "";
  const printed = decimalOf(String(value));
  return written.negative === printed.negative && written.digits === printed.digits && written.exponent === printed.exponent;
}

/** A decimal literal as sign, significant digits (no leading or trailing zeros) and exponent: digits × 10^exponent. */
function decimalOf(text: string): { negative: boolean; digits: string; exponent: number } {
  const [, sign = "", whole = "", fraction = "", exp = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) ?? [];
  const all = (whole + fraction).replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  return { negative: sign === "-", digits, exponent: Number(exp) - fraction.length + (all.length - digits.length) };
}

/** A JSON number token as the grammar allows it, matched at a given position (sticky). */
const STRICT_JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** What {@link scanNumbers} found in a JSON text. */
export interface NumberScan {
  /** The text with each declared member's number value quoted; the input itself when there was none. */
  json: string;
  /** The first undeclared number literal JSON.parse cannot carry exactly, or undefined. */
  inexact: string | undefined;
}

/** No declared big-integer members (`EngineOptions.bigIntegerKeys` left out). */
const NO_KEYS: ReadonlySet<string> = new Set();

/** Whether the member name `json` holds between `start` and `end` (its quotes) is one of `keys`, compared in place. */
function isDeclared(json: string, start: number, end: number, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (end - start - 1 === key.length && json.startsWith(key, start + 1)) return true;
  }
  return false;
}

/** The index of the first character at or after `i` that is not JSON whitespace. */
function skipSpace(json: string, i: number): number {
  for (; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
  }
  return i;
}

/**
 * One linear pass over `json` (the text of an answer) that skips strings (raw control
 * characters in them included) and looks at every number literal:
 * - the value of a member named in `bigIntegerKeys` is quoted, as written (`"_version_":
 *   1858054135406919680` becomes `"_version_":"1858054135406919680"`), so JSON.parse delivers
 *   it exactly as a string, whatever its size. Only a literal the JSON grammar allows is quoted,
 *   so a malformed one (`01`) still fails JSON.parse;
 * - any other number is checked as {@link firstInexactNumber} says, and the first one JSON.parse
 *   cannot carry exactly is reported in `inexact`.
 * Nothing is allocated per value: a member name is compared in place (only a name written with
 * an escape is decoded), and the text is copied only when a declared member is found. No
 * reviver, which would recurse per nesting level and overflow on deep data.
 */
export function scanNumbers(json: string, bigIntegerKeys: ReadonlySet<string> = NO_KEYS): NumberScan {
  const keys = bigIntegerKeys.size === 0 ? undefined : [...bigIntegerKeys];
  let inexact: string | undefined;
  let out: string | undefined;
  let copied = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c === 0x22) {
      // a string: skip to its closing quote, past escapes
      const start = i;
      let escaped = false;
      for (i++; i < json.length; i++) {
        const d = json.charCodeAt(i);
        if (d === 0x5c) {
          escaped = true;
          i++;
        } else if (d === 0x22) break;
      }
      if (keys === undefined) continue;
      // A member name is a string followed by a colon; is it a declared one with a number value?
      const colon = skipSpace(json, i + 1);
      if (json.charCodeAt(colon) !== 0x3a) continue;
      if (!(escaped ? bigIntegerKeys.has(decodedName(json.slice(start, i + 1))) : isDeclared(json, start, i, keys))) continue;
      const at = skipSpace(json, colon + 1);
      STRICT_JSON_NUMBER.lastIndex = at;
      const literal = STRICT_JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      out = (out ?? "") + json.slice(copied, at) + '"' + literal + '"';
      copied = at + literal.length;
      i = copied - 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      JSON_NUMBER.lastIndex = i;
      const literal = JSON_NUMBER.exec(json)?.[0];
      if (literal === undefined) continue;
      const value = Number(literal);
      if (inexact === undefined && (!Number.isFinite(value) || !exactAtTheEdges(literal, value))) {
        inexact = literal;
        if (keys === undefined) break;
      }
      i += literal.length - 1;
    }
  }
  return { json: out === undefined ? json : out + json.slice(copied), inexact };
}

/** A member name written with an escape, decoded; a name JSON.parse can't read matches nothing. */
function decodedName(quoted: string): string {
  try {
    return String(JSON.parse(quoted));
  } catch {
    return "";
  }
}

/**
 * The first number literal in `json` (JSON that parsed) that JSON.parse cannot carry exactly,
 * or undefined: one out of a double's range (`1e400` became Infinity, printed as `null`), one
 * past 2^53 that it rounds, in any form (`12345678901234567890`, `12345678901234567890.0`,
 * `9007199254740993e0` or `9007199254740992.5`), a non-zero one too small for a double
 * (`1e-400` became 0), and a subnormal one that does not print as written (`3e-324` became
 * `5e-324`). Below 2^53 and above the subnormal range a decimal fraction keeps a double's usual
 * precision, as JSON means it. {@link scanNumbers} without declared members.
 */
export function firstInexactNumber(json: string): string | undefined {
  return scanNumbers(json).inexact;
}

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
  baseUrl?: string | undefined;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport | undefined;
  /**
   * Value of the User-Agent header (default `DEFAULT_USER_AGENT`). A blank value,
   * a control character but tab, or a character above U+00FF is rejected with
   * `DipValidationError`.
   */
  userAgent?: string | undefined;
  /** Extra headers sent on every request (e.g. an API key); checked like `userAgent`. */
  defaultHeaders?: Record<string, string> | undefined;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms, else
   * `DipValidationError`). Enforced by the engine for every transport: the
   * transport gets an AbortSignal that fires at the deadline.
   */
  timeoutMs?: number | undefined;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (`isTransientNetworkError`; GET/HEAD only). Each waits
   * `retryDelayMs * attempt`, or the response's `Retry-After` when that is longer
   * (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried, and the error names
   * it). An integer 0..`MAX_RETRIES` (10).
   */
  maxRetries?: number | undefined;
  /**
   * Base backoff between retries in milliseconds (grows linearly; default 200, at most
   * `MAX_RETRY_AFTER_MS`). A Retry-After can lengthen a wait, never shorten it.
   */
  retryDelayMs?: number | undefined;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a DipApiError naming the target. An integer 0..`MAX_REDIRECTS` (10).
   */
  maxRedirects?: number | undefined;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   * A non-negative safe integer. Checked on the body of every transport.
   */
  maxResponseBytes?: number | undefined;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /**
   * Called once per retry, right before the backoff sleep, for each retried 429/503
   * and reset connection; never when there is no retry. A throw is swallowed.
   */
  onRetry?: ((event: RetryEvent) => void) | undefined;
  /**
   * Called with a one-line warning about an answer the engine delivered changed: characters
   * that were not valid text — invalid bytes in the declared (or default UTF-8) charset, or a
   * lone surrogate written as a JSON escape — replaced with U+FFFD. The message names the
   * request and the count (`GET <url>: 2 characters of the answer were not valid text …`).
   * Without it the replacement is silent. A throw is swallowed. The CLI logs it as a `WARN`
   * record of `dip.api`.
   */
  onWarning?: ((message: string) => void) | undefined;
  /**
   * Member names whose number values may exceed 2^53 (a Solr `_version_`, a 64-bit id). The value
   * of a declared member is delivered as its exact literal, as written, as a JSON string (`"5"`),
   * so its type never depends on its size. A declared member whose value is not a number (a
   * string, `null`, an object) is left as it is. Every undeclared number keeps the rule: exact,
   * or a DipParseError. Matched by name anywhere in a JSON answer, an escaped name included.
   * Defaults to none (DIP sends no such member); anything but a set or list of non-empty
   * strings makes the constructor throw a DipValidationError. The set is copied.
   */
  bigIntegerKeys?: ReadonlySet<string> | undefined;
}

/**
 * Read the `bigIntegerKeys` option: `undefined` gives none; a set or list of non-empty strings is
 * copied; anything else throws a DipValidationError.
 */
export function bigIntegerKeysOption(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return NO_KEYS;
  const iterable = typeof value === "object" && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
  const names = iterable ? [...(value as Iterable<unknown>)] : [];
  if (!iterable || names.some((key) => typeof key !== "string" || key === "")) {
    throw new DipValidationError("Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  return new Set(names as string[]);
}

/** What `EngineOptions.onRetry` is told about one retry. */
export interface RetryEvent {
  /** Which retry this is, counting from 1. */
  retry: number;
  /** The most retries this request may make (`maxRetries`). */
  maxRetries: number;
  /** How long the engine waits before sending the request again. */
  delayMs: number;
  /** The HTTP status that caused the retry; absent for a reset connection. */
  status?: number;
  /** The URL being retried, userinfo redacted. */
  url: string;
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
  ["retryDelayMs", MAX_RETRY_AFTER_MS],
  ["maxRedirects", MAX_REDIRECTS],
  ["maxResponseBytes", Number.MAX_SAFE_INTEGER],
];

/**
 * Check every limit that is set: `timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries`
 * 0..`MAX_RETRIES`, `maxRedirects` 0..`MAX_REDIRECTS`, `retryDelayMs`
 * 0..`MAX_RETRY_AFTER_MS` (30 000; a longer base delay would outlast any wait the
 * server may ask for), `maxResponseBytes` any non-negative safe integer. `undefined` keeps the
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
  if (typeof value !== "string") return "Expected an absolute http(s) URL string.";
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

/** The phrase for the DIP API key in `cleartextProblem`'s sentence (as the CLI passes it). */
export const API_KEY_PHRASE = "the API key";

/** The phrase `cleartextProblem` uses for a base URL's `user:password@`. */
const USERINFO_PHRASE = "the base URL's credentials";

/**
 * Why requests to `baseUrl` would cross the network unencrypted, or `undefined`.
 *
 * Returns `undefined` for an `https:` URL, for one that does not parse, and for the
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`). For any other plain
 * `http:` URL it returns one sentence (no `warning: ` prefix) naming the host
 * (`url.host`: host and port, never the userinfo) and what secret travels with the
 * requests: `secrets` are noun phrases such as `"the API key"`, and a `user:password@`
 * in the URL adds "the base URL's credentials". The secrets themselves are never in
 * the sentence. Not an error (a mirror on a trusted network is a legitimate setup),
 * so the CLI logs it as a `WARN` record of `dip.http` (once per run, before the first
 * request); a missing "s" is an easy slip, and DIP itself only answers plain http
 * with a redirect to https.
 *
 * - `requests to <host> are sent unencrypted (http:, not https:)`
 * - `the API key is sent unencrypted to <host> (http:, not https:)`
 * - `the API key and the base URL's credentials are sent unencrypted to <host> (http:, not https:)`
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The WHATWG parser normalises IPv4 (`127.1`, `0x7f.0.0.1`) to dotted decimal.
  if (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  const named = [...secrets];
  if (url.username !== "" || url.password !== "") named.push(USERINFO_PHRASE);
  const tail = `unencrypted to ${url.host} (http:, not https:)`;
  if (named.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const subject = named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;
  const verb = named.length === 1 && named[0] !== USERINFO_PHRASE ? "is" : "are";
  return `${subject} ${verb} sent ${tail}`;
}

/**
 * @deprecated Use {@link cleartextProblem}, which also warns when no secret is sent.
 * Kept for library callers: the same check with `"the API key"` as the secret when
 * `hasKey`, and still `undefined` when neither a key nor a `user:password@` goes out.
 */
export function cleartextCredentialsProblem(baseUrl: string, hasKey: boolean): string | undefined {
  const problem = cleartextProblem(baseUrl, hasKey ? [API_KEY_PHRASE] : []);
  if (problem === undefined || problem.startsWith("requests to ")) return undefined;
  return problem;
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
  // A record built from an answer has no prototype: a header named `__proto__` is an own entry
  // like any other, never the record's prototype (whose entries would read as headers).
  const record = Object.create(null) as Record<string, string | string[] | undefined>;
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

/**
 * Longest server text (in characters) kept for an error message (a `detail`). A longer
 * one is cut and ends in "…", so a hostile or buggy body cannot flood stderr or a CI
 * log with one huge line. `DipApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters (never inside a surrogate pair). */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return cutForMessage(clean, MAX_DETAIL_LENGTH);
}

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function is a DipValidationError. A string `transport` used to fail at the first
 * request as a raw TypeError, and a bad `sleep` on the first retry.
 */
function functionOption<F>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new DipValidationError(`Invalid ${name}: Expected a function, got ${typeof value}.`);
  }
  return value;
}

/**
 * True for the Unicode bidirectional formatting characters: ALM (U+061C), LRM/RLM
 * (U+200E/U+200F), the embeddings and overrides U+202A–U+202E and the isolates
 * U+2066–U+2069. A terminal applies them to the text that follows, so an override
 * in server text can reorder what the user sees ("Trojan Source" spoofing).
 */
export function isBidiControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
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
  private readonly onRetry: ((event: RetryEvent) => void) | undefined;
  private readonly onWarning: ((message: string) => void) | undefined;
  /** `EngineOptions.bigIntegerKeys`, copied. */
  readonly bigIntegerKeys: ReadonlySet<string>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options".
    options = options ?? {};
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
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only `undefined` selects the default; a blank or unsendable value is a
    // DipValidationError, as in the CLI's --user-agent.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertHeaderValue("userAgent", options.userAgent);
    if (options.defaultHeaders !== undefined && !isPlainObject(options.defaultHeaders)) {
      throw new DipValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      assertValid("header name", name, headerNameProblem);
      assertHeaderValue(`${name} header`, value);
    }
    // The secret part of a credential header (`ApiKey <key>` → the key), never echoed.
    // And the forms a server echoes a base URL's userinfo in: the Basic value, the
    // decoded `user:password`, the password alone.
    this.#secrets = Object.entries(this.#defaultHeaders)
      .filter(([name]) => CREDENTIAL_HEADERS.has(name.toLowerCase()))
      .map(([, value]) => value.replace(/^\S+\s+/, "").trim())
      .concat(credentialsIn(this.#baseUrl).flatMap(echoedCredentialForms))
      // Longest first, so a password never leaves half of the user:password around it.
      .sort((a, b) => b.length - a.length);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.sleep = functionOption("sleep", options.sleep, realSleep);
    this.onRetry =
      options.onRetry === undefined ? undefined : functionOption("onRetry", options.onRetry, () => {});
    this.onWarning =
      options.onWarning === undefined ? undefined : functionOption("onWarning", options.onWarning, () => {});
    this.bigIntegerKeys = bigIntegerKeysOption(options.bigIntegerKeys);
  }

  /** Tell `onWarning` about an answer delivered changed. A throwing callback never breaks the request. */
  private warn(message: string): void {
    try {
      this.onWarning?.(message);
    } catch {
      // a logging hook is no reason to fail the request
    }
  }

  /** Tell `onRetry` about a retry, then wait. A throwing callback never breaks the request. */
  private async backOff(attempt: number, delayMs: number, url: string, status?: number): Promise<void> {
    try {
      this.onRetry?.({
        retry: attempt,
        maxRetries: this.maxRetries,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        url: redactUrl(url),
      });
    } catch {
      // a logging hook is no reason to fail the request
    }
    await this.sleep(delayMs);
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
    return this.joinUrl(normalizedPath, query);
  }

  /** Base URL + path + query string, without buildUrl's validation. */
  private joinUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * The request URL as error messages show it: absolute (so a message names the host that
   * gave a bad answer, which matters with a custom base URL), userinfo redacted and cut at
   * `MAX_QUOTED_LENGTH` characters. It never throws: describing a URL for a message does not
   * validate it (buildUrl does).
   */
  describeUrl(path: string, query?: QueryParams): string {
    return cutForMessage(redactUrl(this.joinUrl(path, query)));
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
          await this.backOff(attempt, this.retryDelayMs * attempt, url);
          continue;
        }
        // A reset names only itself ("socket hang up"): say which request it broke off and,
        // like an exhausted 429/503 retry, how many retries ran. The original stays the
        // cause, so isTransientNetworkError still recognises it.
        if (hasTransientCode(cause)) {
          const reason = cause instanceof Error && cause.message.trim() !== "" ? cause.message : "connection reset";
          const retries = attempt === 0 ? "" : ` (after ${attempt} ${attempt === 1 ? "retry" : "retries"})`;
          throw new DipNetworkError(
            `${method} ${redactUrl(url)} failed: ${sanitizeServerText(this.scrub(reason))}${retries}`,
            { cause: this.scrubCause(cause) },
          );
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
        throw new DipNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }
      const response = { status, headers: responseHeaders, body };

      const retryable = status === 429 || status === 503;
      let retryAfterTooLong: number | undefined;
      if (idempotent && retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs * attempt). A Retry-After header can ask for
        // longer, never for less: `Retry-After: 0` or a date in the past would turn the
        // retries into a zero-delay burst against a server that has just asked for less
        // load. One beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces
        // at once and names the wait, since retrying sooner would only land inside it.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.backOff(
            attempt,
            retryAfter === undefined ? backoff : Math.max(retryAfter, backoff),
            url,
            status,
          );
          continue;
        }
        retryAfterTooLong = retryAfter;
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
        throw this.toApiError(method, url, status, response.body, location, undefined, dropped, retryAfterTooLong);
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
      // The built-in transport's own errors (a timeout, the size cap, a refused connection)
      // and the engine's deadline carry no URL: name the request, as for a reset, with the
      // original as the cause. Scrub anyway, in case a custom transport built one from a
      // server's text.
      const message = this.scrub(cause.message);
      const prefix = `${method} ${redactUrl(url)} failed: `;
      if (message.startsWith(prefix)) {
        const inner = this.scrubCause(cause.cause);
        if (message === cause.message && inner === cause.cause) return cause;
        return new DipNetworkError(message, inner === undefined ? undefined : { cause: inner });
      }
      return new DipNetworkError(`${prefix}${message}`, { cause: this.scrubCause(cause) });
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

  /**
   * Perform a GET expecting JSON and parse it into `T`. Every error about the answer names the
   * request (`GET <url>: …`, userinfo redacted), as a network error does.
   *
   * The text is never changed silently: bytes that are not valid in the charset, and lone
   * surrogates written as JSON escapes (`\ud800`), are replaced with U+FFFD, so the result is
   * well-formed text (`jq` rejects a lone surrogate, and with it the whole output), and
   * `onWarning` is told how many. One bad character never sinks a whole answer.
   */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const request = `GET ${this.describeUrl(path, query)}`;
    const decoded = decodeText(res.data, res.contentType, request);
    const text = decoded.text;
    // Every DIP endpoint answers with a JSON document (a list envelope or a
    // record), so an empty 2xx body (or 204 No Content) is a malformed response,
    // not `null`: printing `null` with exit 0 would let a script carry on.
    if (res.status === 204 || text.trim().length === 0) {
      throw new DipParseError(`${request}: empty response body.`);
    }
    // Declared big integers are quoted first, so JSON.parse delivers them exactly.
    const repaired = wellFormedEscapes(text);
    const { json, inexact } = scanNumbers(repaired.json, this.bigIntegerKeys);
    const parsed = parseJsonBody<T>(json, request, res.contentType);
    // JSON.parse rounds an integer beyond 2^53 and turns an out-of-range literal into Infinity
    // (printed as null), silently: refuse the answer rather than print a changed value.
    if (inexact !== undefined) {
      throw new DipParseError(`${request}: the number ${cutForMessage(inexact)} cannot be represented exactly.`);
    }
    const replaced = decoded.replaced + repaired.replaced;
    if (replaced > 0) {
      this.warn(
        `${request}: ${replaced} ${replaced === 1 ? "character" : "characters"} of the answer ${replaced === 1 ? "was" : "were"} ` +
          "not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.",
      );
    }
    return parsed;
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
    retryAfterMs?: number,
  ): DipApiError {
    // The body is kept on the error (`body`); one too large to be a string (maxResponseBytes
    // lifted) is left out: the status is the error.
    let raw = "";
    try {
      raw = body.toString("utf8");
    } catch (err) {
      if (!isStringTooLong(err)) throw err;
    }
    const text = this.scrub(raw);
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
    if (detail !== undefined) detail = cleanDetail(detail);
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
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). TextDecoder drops a leading byte order mark, which Buffer#toString keeps and
 * JSON.parse then rejects, so a BOM added by a proxy cannot turn a valid answer into
 * a parse error, and an `iso-8859-1` body keeps its umlauts. An unknown charset label
 * is a `DipParseError` naming it after `request`, the request it answered
 * (`GET <url>: unsupported response charset "…".`). Bytes that are not valid in the charset
 * become U+FFFD (`getJson` reports how many through `onWarning`).
 */
export function decodeBody(body: Buffer, contentType: string, request: string): string {
  return decodeText(body, contentType, request).text;
}

/**
 * {@link decodeBody}, and how many characters were replaced with U+FFFD: exactly for UTF-8 (a
 * U+FFFD the server sent is not counted) and the single-byte charsets; for UTF-16 a U+FFFD the
 * server sent counts too.
 */
function decodeText(body: Buffer, contentType: string, request: string): { text: string; replaced: number } {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset, { fatal: true });
  } catch {
    throw new DipParseError(`${request}: unsupported response charset "${cutForMessage(sanitizeServerText(charset))}".`);
  }
  try {
    return { text: decoder.decode(body), replaced: 0 };
  } catch (err) {
    if (isStringTooLong(err)) throw tooLargeForText(request, body);
    // Not valid in the charset: decode with replacement, and count what was replaced.
    let text: string;
    try {
      text = new TextDecoder(decoder.encoding).decode(body);
    } catch (again) {
      if (isStringTooLong(again)) throw tooLargeForText(request, body);
      throw again;
    }
    const sent = decoder.encoding === "utf-8" ? countBytes(body, REPLACEMENT_UTF8) : 0;
    return { text, replaced: countChar(text, 0xfffd) - sent };
  }
}

/** V8's longest string (2^29 − 24 characters on 64-bit). */
const MAX_STRING_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * True for V8's error for a string past its longest one: a body of 512 MB and more, possible once
 * `maxResponseBytes` is lifted, can't be decoded into one.
 */
function isStringTooLong(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_STRING_TOO_LONG";
}

/** The parse error for a body too large to decode: it used to escape as a plain Error ("Unexpected error"). */
function tooLargeForText(request: string, body: Buffer): DipParseError {
  return new DipParseError(
    `${request}: the answer is too large to read as text (${body.byteLength} bytes; the longest string is ${MAX_STRING_LENGTH} characters).`,
  );
}

/** U+FFFD in UTF-8. */
const REPLACEMENT_UTF8 = Buffer.from([0xef, 0xbf, 0xbd]);

/** How often `needle` occurs in `body`. */
function countBytes(body: Buffer, needle: Buffer): number {
  let n = 0;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** How often the UTF-16 unit `code` occurs in `text`. */
function countChar(text: string, code: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) n++;
  return n;
}

/** A JSON escape of a surrogate, `\uD800`–`\uDFFF`, anywhere in a text (a cheap pre-check). */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** The value of the four hex digits of a `\uXXXX` escape whose `u` is at `at`, or -1. */
function escapeAt(json: string, at: number): number {
  if (json.charCodeAt(at) !== 0x75) return -1;
  const hex = json.slice(at + 1, at + 5);
  return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

/**
 * `json` (decoded answer text) with every lone surrogate written as a JSON escape (`\ud800` not
 * followed by a low-surrogate escape, or a `\udc00` not preceded by a high one) rewritten as
 * `\ufffd`, and how many. JSON.parse would make such an escape half a character, which a JSON
 * printer writes back as `\ud800` and `jq` refuses (the whole output with it). A raw lone
 * surrogate cannot occur: TextDecoder never makes one. One linear pass, and only when the text
 * holds a surrogate escape at all; the text is copied only when one is lone.
 */
function wellFormedEscapes(json: string): { json: string; replaced: number } {
  if (!SURROGATE_ESCAPE.test(json)) return { json, replaced: 0 };
  let out = "";
  let copied = 0;
  let replaced = 0;
  for (let i = 0; i < json.length; i++) {
    if (json.charCodeAt(i) !== 0x5c) continue;
    const code = escapeAt(json, i + 1);
    if (code < 0xd800 || code > 0xdfff) {
      i++; // an escape of another kind (\", \\, \n, \u0041): skip its second character
      continue;
    }
    const pairedLow = code <= 0xdbff && json.charCodeAt(i + 6) === 0x5c && isLowSurrogate(escapeAt(json, i + 7));
    if (pairedLow) {
      i += 11;
      continue;
    }
    out += json.slice(copied, i) + "\\ufffd";
    copied = i + 6;
    replaced++;
    i += 5;
  }
  return replaced === 0 ? { json, replaced } : { json: out + json.slice(copied), replaced };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
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
