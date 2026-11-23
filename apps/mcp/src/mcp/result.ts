// Shaping a tool's answer before it leaves the server: every string from upstream is cleaned in
// the value (the MCP spec: servers must sanitize tool outputs), and the whole result is kept
// under a size the client and the model can take, by dropping whole list entries, never by
// cutting the JSON.

import { cutText, toWellFormed } from "./api.js";

/** The longest string a result keeps; longer upstream text is cut, with an ellipsis. */
export const MAX_FIELD_LENGTH = 2000;

// Control characters (but TAB and LF), DEL and C1, zero-width and bidi format characters, the
// line and paragraph separators, BOM: invisible or able to reorder or hide text, never content.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

/** `value` with every string (keys too) cleaned and cut; lone surrogates replaced. */
export function cleanStrings<T>(value: T): T {
  if (typeof value === "string") {
    const clean = toWellFormed(value).replace(INVISIBLE, "");
    return (clean.length > MAX_FIELD_LENGTH ? `${cutText(clean, MAX_FIELD_LENGTH)}…` : clean) as T;
  }
  if (Array.isArray(value)) return value.map((item) => cleanStrings(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanStrings(key), cleanStrings(item)])) as T;
  }
  return value;
}

/**
 * `result` cut to at most `maxChars` characters of JSON by dropping entries from the end of
 * its lists (the longest list first), with `truncated: true` and, for a paged list, the
 * `nextOffset` to continue from. A result that fits is returned as it is.
 */
export function fitResult<T extends Record<string, unknown>>(result: T, maxChars: number, paged?: { list: string; offset: number }): T {
  if (JSON.stringify(result).length <= maxChars) return result;
  const fitted: Record<string, unknown> = { ...result, truncated: true };
  const lists = Object.keys(fitted).filter((key) => Array.isArray(fitted[key]));
  for (const key of lists) fitted[key] = [...(fitted[key] as unknown[])];
  // nextOffset counts toward the size, so it is kept current while entries are dropped.
  const mark = (): void => {
    if (paged !== undefined) fitted["nextOffset"] = paged.offset + ((fitted[paged.list] as unknown[] | undefined)?.length ?? 0);
  };
  mark();
  while (JSON.stringify(fitted).length > maxChars) {
    const longest = lists.reduce<string | undefined>(
      (best, key) => ((fitted[key] as unknown[]).length > ((best === undefined ? [] : fitted[best]) as unknown[]).length ? key : best),
      undefined,
    );
    if (longest === undefined || (fitted[longest] as unknown[]).length === 0) break;
    (fitted[longest] as unknown[]).pop();
    mark();
  }
  return fitted as T;
}
