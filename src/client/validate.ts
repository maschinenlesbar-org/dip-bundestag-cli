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
 * the list envelope instead of one document.
 */
export const idProblem: Problem<string> = (id) =>
  id === undefined || id === null || isBlank(String(id)) ? "An id is required, e.g. 123456." : undefined;
