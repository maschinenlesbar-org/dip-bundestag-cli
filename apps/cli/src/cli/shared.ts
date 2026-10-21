// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import { constants } from "node:buffer";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { OutputError, isDirectoryMessage, logOf, outputPathState, refuseOverwrite, type CliDeps } from "./io.js";
import type { RawResponse, RetryEvent } from "@maschinenlesbar.org/dip-bundestag-client/internal/engine";
import { apiKeyProblem, normaliseApiKey, type DipClientOptions } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";

/** The name the API key is stored under in the credentials file (`dip config set api-key`). */
export const API_KEY_CREDENTIAL = "api-key";
import { DipValidationError } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";
import { API_KEY_PHRASE, DEFAULT_BASE_URL, baseUrlProblem, cleartextProblem, isBidiControl } from "@maschinenlesbar.org/dip-bundestag-client/internal/engine";
import { headerValueProblem, intInRangeProblem, nonEmptyProblem } from "@maschinenlesbar.org/dip-bundestag-client/internal/validate";

/**
 * commander value-parser: a non-negative integer in plain decimal notation.
 *
 * Deliberately strict — Number() would happily coerce "0x10" (16), "1e3" (1000),
 * "0b11" (3), whitespace-padded values, and "" / "  " (both 0). We only accept an
 * unpadded run of ASCII digits so the "non-negative integer" promise holds.
 */
export function parseIntArg(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * commander value-parser: a value that is not blank (the library's
 * `nonEmptyProblem`). A blank filter would otherwise be dropped and the command
 * would silently run unfiltered. The library rejects the same values; this is
 * the early, parse-time copy of the check, so commander shows the help.
 */
export function parseNonEmpty(value: string): string {
  const problem = nonEmptyProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header
 * (`--user-agent`): the library's `headerValueProblem` (blank, control characters,
 * characters above U+00FF), reported as a usage error.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * The program's command names (`program.commands` and commander's `help`; a test keeps the
 * list in step). Never a key: `--api-key` refuses one, and the run's redaction leaves one alone.
 */
export const COMMAND_NAMES = [
  "obtain-key",
  "config",
  "vorgang",
  "vorgangsposition",
  "drucksache",
  "drucksache-text",
  "plenarprotokoll",
  "plenarprotokoll-text",
  "aktivitaet",
  "person",
  "help",
] as const;

/**
 * commander value-parser for `--api-key`. A blank flag is a usage error (it would
 * otherwise silently replace DIP_API_KEY and send no key: a CLI-only rule); the
 * rest is the library's: the key is trimmed, and one an HTTP header cannot carry
 * is rejected (`apiKeyProblem`/`normaliseApiKey`), as for DIP_API_KEY.
 */
export function parseApiKey(value: string): string {
  parseNonEmpty(value);
  // `dip --api-key $DIP_KEY vorgang list` with an empty, unquoted variable hands commander
  // the command as the key's value: say that, rather than "unknown command 'list'".
  if ((COMMAND_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `"${value}" is a dip command, not a key: --api-key needs the key after it (an empty or unset ` +
        `variable leaves it out). Pass the key, or leave --api-key out to use DIP_API_KEY or the credentials file.`,
    );
  }
  const problem = apiKeyProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return normaliseApiKey(value) as string;
}

/**
 * commander value-parser for `-o, --output <file>`. A blank or whitespace-only path
 * is a usage error: `-o ""` used to print to stdout silently and `-o " "` created a
 * file named " ". `-` is kept as is and means stdout (see {@link action}), the
 * usual convention, rather than a file named "-".
 */
export function parseOutputPath(value: string): string {
  return parseNonEmpty(value);
}

/**
 * Build a commander value-parser for a plain decimal integer constrained to
 * [min, max], checked by the library's `intInRangeProblem` (the bounds come from
 * the library's constants, e.g. `MAX_RETRIES`).
 */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  const problem = intInRangeProblem(min, max);
  return (value: string) => {
    const n = parseIntArg(value);
    const reason = problem(n);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
    return n;
  };
}

/**
 * commander value-parser for `--base-url`: the library's `baseUrlProblem` (an
 * absolute http(s) URL without query, fragment, whitespace or a trailing
 * `/api/v1`), reported as a usage error. A `file:`/`ftp:` or malformed value
 * never reaches the request engine.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export interface GlobalOptions {
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
  output?: string;
  force?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): DipClientOptions {
  const options: DipClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  // The client trims the key and treats a blank one as none (normaliseApiKey);
  // a blank --api-key is rejected at parse time and a blank DIP_API_KEY is unset
  // (readEnvApiKey). No key is bundled: with none the header is omitted and the
  // API answers 401.
  if (global.apiKey !== undefined) options.apiKey = global.apiKey;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  // The library checks the value (a blank one included); --user-agent's parser
  // runs the same check earlier.
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** True for a UTF-16 unit `escapeControlChars` writes as `\uXXXX`. */
function escaped(c: number): boolean {
  return (c >= 0x7f && c <= 0x9f) || isBidiControl(c);
}

/** How many input characters `escapeControlChars` turns into one piece of output at a time. */
const ESCAPE_CHUNK = 1 << 16;

/**
 * Escape the characters JSON.stringify leaves raw although a terminal acts on them. It
 * escapes C0 (including ESC) but not DEL, the C1 range U+0080–U+009F (U+009B is the 8-bit
 * form of CSI) or the bidi formatting characters (isBidiControl), which reorder the text that
 * follows. The output is server data, so escape them; the result is equivalent, valid JSON
 * (these characters only occur inside strings). Checked by char code so the source stays
 * free of control bytes.
 *
 * Each such character becomes six, so the output is measured first: one longer than V8's
 * longest string is an OutputError ("too large to print"), before anything is built. Then the
 * output is built in chunks of ESCAPE_CHUNK characters, each made flat at once, and joined
 * once: one `+=` per character made a rope of 100 M pieces on an answer of DEL characters, and
 * the process died of a heap out-of-memory crash.
 */
export function escapeControlChars(json: string): string {
  let count = 0;
  for (let i = 0; i < json.length; i++) if (escaped(json.charCodeAt(i))) count++;
  if (count === 0) return json;
  const length = json.length + 5 * count;
  if (length > MAX_TEXT_LENGTH) {
    throw new OutputError(`The answer is too large to print (${length} characters once its control characters are escaped).`);
  }
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += ESCAPE_CHUNK) {
    const end = Math.min(start + ESCAPE_CHUNK, json.length);
    const parts: string[] = [];
    let from = start;
    for (let i = start; i < end; i++) {
      const c = json.charCodeAt(i);
      if (!escaped(c)) continue;
      parts.push(json.slice(from, i), "\\u" + c.toString(16).padStart(4, "0"));
      from = i + 1;
    }
    parts.push(json.slice(from, end));
    chunks.push(parts.join(""));
  }
  return chunks.join("");
}

/** The longest string V8 makes (2^29 - 24 characters on 64-bit): a longer JSON text can't be printed at once. */
const MAX_TEXT_LENGTH = constants.MAX_STRING_LENGTH;

/**
 * JSON.stringify, pretty or compact. Printing can fail two ways, both an OutputError (exit 1, an
 * ERROR record of `dip.output`) that names the cause, never "Unexpected error":
 * - an answer nested too deeply (hostile or broken) overflows the stack: "nested too deeply";
 * - a text longer than V8's longest string ("Invalid string length"): "too large to print".
 * "try --compact" is added only when the compact form of this very answer prints: it is probed,
 * not assumed, because whether compact output survives deep nesting depends on the Node version
 * (on Node 26 only the fast path is iterative) and on the machine's stack. On Node 22 and 24 the
 * hint was wrong advice: --compact failed at the same depth.
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? stringifyCompact(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    const deep = /call stack/i.test(err.message);
    const cause = deep ? "nested too deeply" : `too large (more than ${MAX_TEXT_LENGTH} characters of JSON)`;
    const hint = !compact && compactPrints(value) ? "; try --compact" : "";
    throw new OutputError(`The answer is ${cause} to ${compact ? "print" : "pretty-print"}${hint}.`, { cause: err });
  }
}

/** Compact JSON: the fast path, or the gap path for an answer holding a huge string. */
function stringifyCompact(value: unknown): string {
  return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
}

/** Whether `--compact` prints this answer on this runtime (the hint after a failed pretty-print). */
function compactPrints(value: unknown): boolean {
  try {
    return stringifyCompact(value).length <= MAX_TEXT_LENGTH;
  } catch {
    return false;
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/**
 * Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting
 * costs no stack, linear, and without an allocation per value: an array is walked by index, an
 * object by `for…in` (own keys only: an answer's objects have none inherited), and only nested
 * objects and arrays are kept for later. (`Object.entries` made a pair per element: on an array
 * of 48M numbers that took 7 GB and crashed.)
 */
function holdsHugeString(value: unknown): boolean {
  if (typeof value === "string") return value.length >= HUGE_STRING_LENGTH;
  const pending: object[] = [];
  if (typeof value === "object" && value !== null) pending.push(value);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        const element: unknown = item[i];
        if (typeof element === "string") {
          if (element.length >= HUGE_STRING_LENGTH) return true;
        } else if (typeof element === "object" && element !== null) pending.push(element);
      }
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key in record) {
      if (key.length >= HUGE_STRING_LENGTH) return true;
      const element = record[key];
      if (typeof element === "string") {
        if (element.length >= HUGE_STRING_LENGTH) return true;
      } else if (typeof element === "object" && element !== null) pending.push(element);
    }
  }
  return false;
}

/**
 * `deps.io.writeFile`, with any failure an `OutputError` (message and cause kept), so
 * every `-o` failure is logged under `dip.output`, whatever the `CliIO` threw.
 */
function writeOutputFile(deps: CliDeps, path: string, data: Buffer, force: boolean | undefined): void {
  try {
    deps.io.writeFile(path, data, force);
  } catch (cause) {
    if (cause instanceof OutputError) throw cause;
    throw new OutputError(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/**
 * Check `-o` before any request, so a refused target costs none: `--force` without `-o`, a
 * directory, and an existing path (a dangling link too) without `--force` are usage errors
 * (exit 2, an ERROR record of `dip.cli`). `-o -` is stdout. The write checks again: a file
 * that appears during the request is not overwritten either (an OutputError then, exit 1).
 */
export function checkOutputTarget(deps: CliDeps, global: GlobalOptions): void {
  if (global.force === true && global.output === undefined) {
    throw new DipValidationError("--force needs --output (it only allows overwriting the -o file).");
  }
  if (global.output === undefined || global.output === "-") return;
  const state = (deps.io.outputState ?? outputPathState)(global.output);
  if (state === "directory") throw new DipValidationError(isDirectoryMessage(global.output));
  if (state === "exists" && global.force !== true) throw new DipValidationError(refuseOverwrite(global.output));
}

/**
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short stderr confirmation so stdout stays
 * clean for piping), or to stdout otherwise. An existing file is not overwritten
 * unless --force is set.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  if (global.output) {
    const data = Buffer.from(text + "\n", "utf8");
    writeOutputFile(deps, global.output, data, global.force);
    logOf(deps).info("output", `Wrote ${data.length} bytes to ${global.output}`);
  } else {
    deps.io.out(text);
  }
}

/**
 * Render a raw (binary/text) download. Writes to the file given by --output, or
 * to stdout otherwise. Prints a short confirmation to stderr when writing a file
 * so stdout stays clean for piping. An existing file is not overwritten unless
 * --force is set.
 */
export function renderRaw(deps: CliDeps, global: GlobalOptions, response: RawResponse): void {
  if (global.output) {
    writeOutputFile(deps, global.output, response.data, global.force);
    logOf(deps).info("output", `Wrote ${response.data.length} bytes to ${global.output}`);
  } else {
    deps.io.outBinary(response.data);
  }
}

/**
 * Log a warning (`dip.http`) when the effective base URL (`--base-url`, else
 * the default) is plain `http:` to a host other than the loopback interface
 * (`cleartextProblem`), naming the API key when one is sent. Called once per run,
 * after the options are parsed and before the first request; stdout and the exit code
 * are untouched.
 */
export function warnIfCleartext(deps: CliDeps, baseUrl: string | undefined, sendsKey: boolean): void {
  const problem = cleartextProblem(baseUrl ?? DEFAULT_BASE_URL, sendsKey ? [API_KEY_PHRASE] : []);
  if (problem !== undefined) logOf(deps).warn("http", problem);
}

/** `HTTP 503 from host: retry 1 of 3 in 2 s` (host only; whole seconds, ms under 1 s). */
export function retryMessage(event: RetryEvent): string {
  let host: string;
  try {
    host = new URL(event.url).host;
  } catch {
    host = "the server";
  }
  const why = event.status === undefined ? "connection reset" : `HTTP ${event.status}`;
  const wait = event.delayMs < 1000 ? `${event.delayMs} ms` : `${Math.round(event.delayMs / 1000)} s`;
  return `${why} from ${host}: retry ${event.retry} of ${event.maxRetries} in ${wait}`;
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    // A refused -o target is a usage error before anything else happens.
    checkOutputTarget(deps, global);
    // `-o -` means stdout: from here on it is the same as no -o.
    if (global.output === "-") delete global.output;
    const options = toEngineOptions(global);
    // flag > DIP_API_KEY > the credentials file (`dip config set api-key`) > none. The
    // file is read only here, when no key came from the first two, so a problem with
    // it never stands in the way of a key given another way.
    if (options.apiKey === undefined && deps.credentials !== undefined) {
      const store = deps.credentials();
      const stored = store.usable(API_KEY_CREDENTIAL);
      if (stored !== undefined) {
        deps.addSecret?.(stored);
        options.apiKey = stored;
        deps.storedKeyPath = store.path;
      }
    }
    options.onRetry = (event) => logOf(deps).warn("http", retryMessage(event));
    // Text in an answer replaced with U+FFFD is said, never silent (D2).
    options.onWarning = (message) => logOf(deps).warn("api", message);
    const client = deps.createClient(options);
    // Built first, so a key the client rejects is a usage error before any warning.
    warnIfCleartext(deps, options.baseUrl, options.apiKey !== undefined);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}

/** The options that may be given more than once: each adds a filter (DIP's OR set, f.id). */
const REPEATABLE_OPTIONS: ReadonlySet<string> = new Set(["--filter", "--id"]);

/**
 * Make giving a single-value option twice a usage error, on `command` and every subcommand.
 * Commander keeps the last value silently: `--api-key A --api-key B` sent B, and
 * `--base-url a --base-url b` asked b, with nothing telling the user a value was dropped.
 * Flags without a value and the repeatable `--filter`/`--id` are left alone. Call it once on a
 * freshly built program: the check counts per Option object.
 */
export function forbidRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if ((!option.required && !option.optional) || option.variadic) continue;
    if (option.long !== undefined && REPEATABLE_OPTIONS.has(option.long)) continue;
    const parse = option.parseArg;
    let given = false;
    const guarded = (value: string, previous: unknown): unknown => {
      if (given) throw new InvalidArgumentError(`${option.long ?? option.short} may be given only once.`);
      given = true;
      return parse === undefined ? value : parse(value, previous);
    };
    option.parseArg = guarded as typeof option.parseArg;
  }
  for (const child of command.commands) forbidRepeatedOptions(child);
}
