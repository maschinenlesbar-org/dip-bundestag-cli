// Input validation for the library. Every rule about what a request may contain
// lives here (or is called from here), so the client enforces it before any
// request and the CLI's commander parsers call the very same functions instead
// of keeping their own copies.
//
//   - A `Problem` returns the reason a value is invalid, or `undefined` if it is
//     valid. Reasons never echo the value (it may be a credential).
//   - `assertValid` turns a reason into a `DipValidationError` with the message
//     `Invalid <name>: <reason>`.

import { DipValidationError, cutForMessage, quoteValue } from "./errors.js";
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
  typeof value !== "string" ? "Expected a string." : isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * A text filter as DIP matches it: without surrounding whitespace (Unicode whitespace,
 * U+3000 included; a value pasted with a trailing space matched nothing) and in composed
 * Unicode, NFC (a decomposed "Müller", u plus U+0308, matched nothing). Inner whitespace is
 * kept. A value blank once trimmed never gets here: `assertNonBlankParams` refuses it first.
 */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. DIP reads such a
 * value as no filter, or matches nothing with it, so it is refused as blank.
 */
function holdsNothing(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter (`TEXT_FILTERS`), or undefined when it can.
 * Refused, before any request, as DIP would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks: an empty filter reads as "no filter";
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (holdsNothing(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a value DIP
 * compares exactly: a `get` id, a code (`f.zuordnung`, `f.dokumentart`, `f.gesta`), a document
 * number, a date. The rules apply to the value with surrounding whitespace trimmed, as it is
 * sent (`normalizeToken`): not blank (and not only invisible characters or combining marks), no
 * lone surrogate, and no control or format character at all (a zero-width space, a soft hyphen,
 * a bidi control), since an invisible character in a code only ever makes it match nothing.
 * The reason quotes the value visibly. (The repo knows no list of DIP's code values, so a code
 * is checked for its form only.)
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (holdsNothing(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/**
 * A token as it is sent: trimmed and in composed Unicode (NFC). A document number or code
 * pasted with a trailing space (`f.dokumentnummer=20/6875 `) matched nothing, with exit 0.
 * Check it with {@link tokenProblem} first.
 */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list value, as typed: each item is checked (`listProblem`)
 * and canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and `"a1,,a2"`,
 * `"a1,"` and `","` are refused rather than sent as an empty item. (DIP takes repeated
 * parameters, not comma lists; this is the kit's helper for a caller that splits one.)
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** True for a plain object (`{}`, `Object.create(null)`), not an array, class instance or primitive. */
export function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Why one query value cannot be sent, or `undefined`: a string, a finite number, a
 * boolean or a valid Date. `String()` would turn anything else into a filter DIP
 * cannot match (`[object Object]`, `NaN`, `Invalid Date`).
 */
const queryScalarProblem: Problem<unknown> = (value) => {
  if (typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "Expected a finite number.";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Expected a valid Date." : undefined;
  return "Expected a string, number, boolean or Date (or an array of them).";
};

/**
 * Reject query parameters that would silently widen a list request or send a value
 * DIP cannot match: params that are not a plain object, a blank parameter name, a
 * blank string value, an empty array, a blank string inside an array, and a value
 * that is not a string, finite number, boolean or valid Date. `cursor` takes one
 * string. `undefined` and `null` still mean "omitted". Throws `DipValidationError`
 * naming the parameter (`Invalid f.titel: ...`).
 */
export function assertNonBlankParams(params: QueryParams): void {
  if (!isPlainObject(params)) {
    throw new DipValidationError("Invalid params: Expected an object of filters, e.g. { \"f.titel\": \"Klima\" }.");
  }
  for (const [key, raw] of Object.entries(params)) {
    assertValid("query parameter name", key, nonEmptyProblem);
    if (raw === undefined || raw === null) continue;
    if (key === "cursor" && typeof raw !== "string") {
      throw new DipValidationError("Invalid cursor: Expected one cursor string from the previous page.");
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) throw new DipValidationError(`Invalid ${key}: Expected at least one value.`);
      for (const value of raw) {
        if (value === undefined || value === null) continue;
        assertValid(key, value, queryScalarProblem);
        if (typeof value === "string") assertValid(key, value, nonEmptyProblem);
      }
    } else {
      assertValid(key, raw, queryScalarProblem);
      if (typeof raw === "string") assertValid(key, raw, nonEmptyProblem);
    }
  }
}

/**
 * A document id for `get(id)` must not be blank: an empty last path segment
 * turns `/api/v1/vorgang/<id>` into the collection endpoint, which answers with
 * the list envelope instead of one document. Nor may it be "." or "..":
 * `encodeURIComponent` leaves both unchanged and URL parsing resolves them, so
 * they would request the list or the API root. Nor may it hold a "/". (Longer dot
 * runs and percent-encoded forms such as "%2e%2e" are ordinary ids.)
 */
export const idProblem: Problem<string> = (id) => {
  if (id === undefined || id === null) return "An id is required, e.g. 123456.";
  // A JavaScript caller may pass a number (DIP ids are numeric); anything else would be
  // sent as "[object Object]".
  if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) {
    return "Expected an id string, e.g. \"123456\".";
  }
  if (isBlank(String(id))) return "An id is required, e.g. 123456.";
  // An invisible or control character, a lone surrogate, or only invisible characters.
  if (typeof id === "string") {
    const problem = tokenProblem(id);
    if (problem !== undefined) return problem;
  }
  if (id === "." || id === "..") return '"." and ".." cannot be used as an id.';
  // encodeURIComponent sends it as %2F, which a server or proxy that decodes it reads as more
  // path segments ("a1/../a2" re-targets the request); no DIP id holds one.
  if (String(id).includes("/")) return 'An id cannot contain "/".';
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
  // A JavaScript caller may pass anything; `{}.trim()` was a raw TypeError.
  if (typeof value !== "string") return "Expected a string.";
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
  if (typeof value === "object") return `an object with ${Object.keys(value as object).slice(0, 5).map((k) => JSON.stringify(cutForMessage(k))).join(", ") || "no keys"}`;
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
