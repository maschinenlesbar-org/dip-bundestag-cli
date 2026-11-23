// Shaping a tool's answer before it leaves the server: every string from upstream is cleaned in
// the value (the MCP spec: servers must sanitize tool outputs), and the whole result is kept
// under a size the client and the model can take, by dropping whole list entries and cutting long
// texts, never by cutting the JSON.

import { cutText, toWellFormed } from "./api.js";

/**
 * The longest string a result keeps (a tool may allow more: ToolDefinition.maxFieldLength); longer
 * upstream text is cut and ends in a mark that says so (cutMark), the mark counted in.
 */
export const MAX_FIELD_LENGTH = 2000;

const ELLIPSIS = "…";

/** What a cut string ends in: the model sees that it has a part, and how long the whole was. */
export function cutMark(total: number): string {
  return `${ELLIPSIS}[cut, ${total} characters in all]`;
}

export interface CleanOptions {
  /** The longest string kept, cut mark included (default MAX_FIELD_LENGTH). */
  maxLength?: number;
  /** Called for every string that is cut (the server then marks the result `truncated`). */
  onCut?: () => void;
}

// What is invisible or able to reorder or hide text, never content: control characters (but TAB
// and LF), DEL and C1, every Default_Ignorable_Code_Point (zero-width and bidi format characters,
// BOM, soft hyphen, variation selectors, Hangul fillers, the tag characters U+E0000 to U+E007F that
// spell text no reader sees), the line and paragraph separators and the interlinear annotation
// marks. Two of them are kept where they belong to an emoji (the first group): a zero-width joiner
// between two emoji (a family of three is three emoji joined so) and the emoji style selector
// U+FE0F right after one (a red heart); stacked or elsewhere they are dropped. A flag's tag
// sequence goes with the other tags (it can carry any text): the flag stays, black. Each
// alternative matches its character first, so the look-behinds run only at a joiner or selector.
const INVISIBLE =
  /(\u200d(?<=\p{Extended_Pictographic}(?:\ufe0f|\p{Emoji_Modifier})?\u200d)(?=\p{Extended_Pictographic})|\ufe0f(?<=\p{Extended_Pictographic}\ufe0f))|(?![\t\n])[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029\ufff9-\ufffb]/gu;

/** `text` without invisible characters (INVISIBLE), lone surrogates replaced; not cut. */
export function cleanText(text: string): string {
  return toWellFormed(text).replace(INVISIBLE, (_, emoji: string | undefined) => emoji ?? "");
}

/**
 * `value` with every string (keys too) cleaned and cut; lone surrogates replaced. A cut string
 * ends in cutMark and is at most `maxLength` long, so cleaning it again changes nothing. A key that
 * cleaning makes equal to another key gets a suffix (`~2`, `~3`, …) and a key that was clean keeps
 * its name: no value is lost, and an upstream can't take a field's name with an invisible character.
 */
export function cleanStrings<T>(value: T, options: CleanOptions = {}): T {
  if (typeof value === "string") {
    const clean = cleanText(value);
    const max = options.maxLength ?? MAX_FIELD_LENGTH;
    if (clean.length <= max) return clean as T;
    options.onCut?.();
    const mark = cutMark(clean.length);
    return `${cutText(clean, max - mark.length)}${mark}` as T;
  }
  if (Array.isArray(value)) return value.map((item) => cleanStrings(item, options)) as T;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, item]) => [key, cleanStrings(key, options), cleanStrings(item, options)] as const);
    const taken = new Set(entries.filter(([key, clean]) => key === clean).map(([key]) => key));
    // The next suffix to try per cleaned key, so many alike keys stay linear.
    const next = new Map<string, number>();
    return Object.fromEntries(
      entries.map(([key, clean, item]) => {
        if (key === clean) return [key, item];
        let n = next.get(clean) ?? 2;
        let name = clean;
        while (taken.has(name)) name = `${clean}~${n++}`;
        next.set(clean, n);
        taken.add(name);
        return [name, item];
      }),
    ) as T;
  }
  return value;
}

/**
 * `text` cut to at most `max` characters by taking out its middle, which a mark replaces: for a
 * message whose start says what failed and whose end says why. A quarter of the room goes to the
 * start, the rest to the end; neither cut splits a character.
 */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const mark = `${ELLIPSIS}[cut, ${text.length} characters in all]${ELLIPSIS}`;
  const head = cutText(text, Math.floor((max - mark.length) / 4));
  const tail = text.slice(text.length - (max - mark.length - head.length));
  // A tail that starts with the second half of a character drops it.
  return `${head}${mark}${/^[\udc00-\udfff]/.test(tail) ? tail.slice(1) : tail}`;
}

/** The shortest a text is cut to so that a result fits under the cap, its cut mark counted in. */
const MIN_FIT_LENGTH = 100;

/**
 * A result's own fields, never cut to fit: what the answer is, where it came from, under what
 * licence, and its notes (what the tool warns about the data, which must stay with it).
 */
const OWN_FIELDS = new Set(["status", "source", "licence", "reason", "notes"]);

const CUT_MARK = /…\[cut, (\d+) characters in all\]$/;

/** The longest string in `value`. */
function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (typeof value !== "object" || value === null) return 0;
  return Object.values(value).reduce<number>((longest, item) => Math.max(longest, longestString(item)), 0);
}

/** `value` with every string longer than `max` cut to `max`, ending in a cut mark with its whole length. */
function shorten(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    // A text cut before keeps the whole length its mark already names.
    const marked = CUT_MARK.exec(value);
    const mark = cutMark(marked === null ? value.length : Number(marked[1]));
    return `${cutText(marked === null ? value : value.slice(0, marked.index), max - mark.length)}${mark}`;
  }
  if (Array.isArray(value)) return value.map((item) => shorten(item, max));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shorten(item, max)]));
  return value;
}

/** The largest n from `low` to `high` for which `fits(n)` holds (it holds for every smaller one), else `low`. */
function largest(low: number, high: number, fits: (n: number) => boolean): number {
  let best = low;
  while (low <= high) {
    const n = Math.floor((low + high) / 2);
    if (fits(n)) [best, low] = [n, n + 1];
    else high = n - 1;
  }
  return best;
}

/**
 * `result` cut to at most `maxChars` characters of JSON, never by cutting the JSON, with
 * `truncated: true`. First a paged list loses entries from its end (`nextOffset` says where to
 * continue, so they can be had); then, if that is enough, the longest texts are cut further, each
 * to no less than MIN_FIT_LENGTH and ending in a cut mark; else the other lists lose entries (the
 * longest first; `reason` names them and ends in `hint`), then the texts are cut. A list keeps
 * its first entry, and the server's own fields (OWN_FIELDS) stay whole. A result that fits is
 * returned as it is; one that can't be cut so far is undefined (the caller answers with an error).
 */
export function fitResult<T extends Record<string, unknown>>(result: T, maxChars: number, paged?: { list: string; offset: number }, hint = ""): T | undefined {
  if (JSON.stringify(result).length <= maxChars) return result;
  let fitted: Record<string, unknown> = { ...result, truncated: true };
  const fits = (): boolean => JSON.stringify(fitted).length <= maxChars;
  // A list keeps its first entry: a page so that nextOffset always moves on, any list so that it
  // never stands empty beside a total that counts what was there. Only a page that lost entries
  // gets a nextOffset (one the tool set for its next page stays).
  const shortenList = (key: string): void => {
    const list = fitted[key];
    if (!Array.isArray(list) || list.length <= 1) return;
    const keep = (n: number): boolean => {
      fitted[key] = list.slice(0, n);
      if (key === paged?.list) fitted["nextOffset"] = paged.offset + n;
      return fits();
    };
    keep(largest(1, list.length - 1, keep));
  };
  // The texts, the longest first: every one over the length found is cut to it, when a length of
  // at least MIN_FIT_LENGTH makes the result fit; else nothing is cut.
  const cutTexts = (): boolean => {
    const whole = fitted;
    const cutTo = (max: number): Record<string, unknown> => Object.fromEntries(Object.entries(whole).map(([key, item]) => [key, OWN_FIELDS.has(key) ? item : shorten(item, max)]));
    const longest = Math.max(0, ...Object.entries(whole).map(([key, item]) => (OWN_FIELDS.has(key) ? 0 : longestString(item))));
    if (longest <= MIN_FIT_LENGTH || ((fitted = cutTo(MIN_FIT_LENGTH)), !fits())) {
      fitted = whole;
      return false;
    }
    fitted = cutTo(largest(MIN_FIT_LENGTH, longest - 1, (max) => ((fitted = cutTo(max)), fits())));
    return true;
  };
  if (paged !== undefined) shortenList(paged.list);
  if (fits() || cutTexts()) return fitted as T;
  const length = (key: string): number => (fitted[key] as unknown[]).length;
  const others = Object.keys(fitted).filter((key) => key !== paged?.list && !OWN_FIELDS.has(key) && Array.isArray(fitted[key]) && length(key) > 1);
  // What these lists lose can't be had with nextOffset: `reason` says which were cut.
  const said = typeof fitted["reason"] === "string" ? `${fitted["reason"]} ` : "";
  const cut: string[] = [];
  for (const key of others.sort((a, b) => length(b) - length(a))) {
    cut.push(key);
    fitted["reason"] = `${said}To fit the size cap, ${cut.join(", ")} lost entries from the end.${hint === "" ? "" : ` ${hint}`}`;
    shortenList(key);
    if (fits()) return fitted as T;
  }
  return cutTexts() ? (fitted as T) : undefined;
}
