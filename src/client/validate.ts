// Input validation for the library. Every rule about what a request may contain
// lives here (or is called from here), so the client enforces it before any
// request and the CLI's commander parsers call the very same functions instead
// of keeping their own copies.
//
//   - A `Problem` returns the reason a value is invalid, or `undefined` if it is
//     valid. Reasons never echo the value (it may be a credential).
//   - `assertValid` turns a reason into a `DipValidationError` with the message
//     `Invalid <name>: <reason>`.

import { DipValidationError } from "./errors.js";
import type { QueryParams } from "./query.js";

/** Returns why `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a `DipValidationError` (`Invalid <name>: <reason>`) when `problem` finds
 * `value` invalid; otherwise return `value` unchanged.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new DipValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** True for an empty or whitespace-only string. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A blank value ("" or whitespace only) is invalid: DIP treats an empty
 * parameter as no filter (or, for `cursor`, as page one), so the request would
 * silently run unfiltered.
 */
export const nonEmptyProblem: Problem<string> = (value) =>
  isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * Reject query parameters that would silently widen a list request: a blank
 * parameter name, a blank string value, an empty array, or a blank string inside
 * an array. `undefined` and `null` still mean "omitted". Throws
 * `DipValidationError` naming the parameter (`Invalid f.titel: ...`).
 */
export function assertNonBlankParams(params: QueryParams): void {
  for (const [key, raw] of Object.entries(params)) {
    assertValid("query parameter name", key, nonEmptyProblem);
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      if (raw.length === 0) throw new DipValidationError(`Invalid ${key}: Expected at least one value.`);
      for (const value of raw) if (typeof value === "string") assertValid(key, value, nonEmptyProblem);
    } else if (typeof raw === "string") {
      assertValid(key, raw, nonEmptyProblem);
    }
  }
}

/**
 * A document id for `get(id)` must not be blank: an empty last path segment
 * turns `/api/v1/vorgang/<id>` into the collection endpoint, which answers with
 * the list envelope instead of one document. Nor may it be "." or "..":
 * `encodeURIComponent` leaves both unchanged and URL parsing resolves them, so
 * they would request the list or the API root. (Longer dot runs and
 * percent-encoded forms such as "%2e%2e" are ordinary ids.)
 */
export const idProblem: Problem<string> = (id) => {
  if (id === undefined || id === null || isBlank(String(id))) return "An id is required, e.g. 123456.";
  if (id === "." || id === "..") return '"." and ".." cannot be used as an id.';
  return undefined;
};

/**
 * A safe integer in `[min, max]`. Without an upper bound (`max` is
 * `Number.MAX_SAFE_INTEGER`) the reason reads "Expected a non-negative integer.",
 * matching the CLI's integer parser.
 */
export function intInRangeProblem(min: number, max: number): Problem<number> {
  const reason =
    min === 0 && max === Number.MAX_SAFE_INTEGER
      ? "Expected a non-negative integer."
      : `Expected an integer between ${min} and ${max}.`;
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? undefined
      : reason;
}

/**
 * A value Node can send in an HTTP header: not blank, no C0 control character
 * but tab, no DEL, nothing above U+00FF. Node's HTTP layer throws an opaque
 * "Invalid character in header content" for the others, and a CR/LF handed to a
 * custom transport could inject a header. Checked by char code so the source
 * stays free of control bytes.
 */
export const headerValueProblem: Problem<string> = (value) => {
  const blank = nonEmptyProblem(value);
  if (blank !== undefined) return blank;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name: a non-empty RFC 9110 token. */
export const headerNameProblem: Problem<string> = (name) =>
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ? undefined : "Expected an HTTP header name (a token).";

/**
 * Throw `DipValidationError` (`Invalid <name>: <reason>`) unless `value` can be
 * sent as a header value (`headerValueProblem`); return it unchanged.
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/** A short, safe description of a JSON value's kind, for a message. */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return `an object with ${Object.keys(value as object).slice(0, 5).map((k) => JSON.stringify(k)).join(", ") || "no keys"}`;
  return `a ${typeof value}`;
}

/**
 * Why a 2xx body is not a DIP list envelope, or `undefined` when it is: an object with
 * a numeric `numFound`, a `documents` array of objects and, if present, a string
 * `cursor`. A proxy, mirror or upstream fault answering `null`, `[]`, a string or an
 * error object (`{"error": …}`) with HTTP 200 must not be printed as an empty or valid
 * result with exit 0.
 */
export const listResultProblem: Problem<unknown> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `expected a DIP list (numFound, documents), got ${kindOf(value)}`;
  }
  const v = value as Record<string, unknown>;
  const numFound = v["numFound"];
  const documents = v["documents"];
  if (typeof numFound !== "number" || !Number.isFinite(numFound) || !Array.isArray(documents)) {
    return `expected a DIP list (numFound, documents), got ${kindOf(value)}`;
  }
  if (documents.some((d) => typeof d !== "object" || d === null || Array.isArray(d))) {
    return "expected a DIP list whose documents are objects";
  }
  if (v["cursor"] !== undefined && typeof v["cursor"] !== "string") return "expected a string cursor";
  return undefined;
};

/**
 * Why a 2xx body is not a DIP document, or `undefined` when it is: an object with an
 * `id` (every DIP resource has one), not a list envelope or an error object.
 */
export const documentProblem: Problem<unknown> = (value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `expected a DIP document (an object with an id), got ${kindOf(value)}`;
  }
  const id = (value as Record<string, unknown>)["id"];
  if ((typeof id !== "string" && typeof id !== "number") || String(id).trim() === "") {
    return `expected a DIP document (an object with an id), got ${kindOf(value)}`;
  }
  return undefined;
};
