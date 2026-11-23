// Shaping a tool's answer before it leaves the server: every string from upstream is cleaned in
// the value (the MCP spec: servers must sanitize tool outputs), and the whole result is kept
// under a size the client and the model can take, by dropping whole list entries, never by
// cutting the JSON.

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
