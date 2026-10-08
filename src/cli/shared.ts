// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { RawResponse } from "../client/engine.js";
import { apiKeyProblem, normaliseApiKey, type DipClientOptions } from "../client/client.js";

/** The name the API key is stored under in the credentials file (`dip config set api-key`). */
export const API_KEY_CREDENTIAL = "api-key";
import { DipError } from "../client/errors.js";
import { API_KEY_PHRASE, DEFAULT_BASE_URL, baseUrlProblem, cleartextProblem } from "../client/engine.js";
import { headerValueProblem, intInRangeProblem, nonEmptyProblem } from "../client/validate.js";

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
 * commander value-parser for `--api-key`. A blank flag is a usage error (it would
 * otherwise silently replace DIP_API_KEY and send no key: a CLI-only rule); the
 * rest is the library's: the key is trimmed, and one an HTTP header cannot carry
 * is rejected (`apiKeyProblem`/`normaliseApiKey`), as for DIP_API_KEY.
 */
export function parseApiKey(value: string): string {
  parseNonEmpty(value);
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

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a DipError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new DipError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
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
    deps.io.writeFile(global.output, data, global.force);
    deps.io.err(`Wrote ${data.length} bytes to ${global.output}`);
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
    deps.io.writeFile(global.output, response.data, global.force);
    deps.io.err(`Wrote ${response.data.length} bytes to ${global.output}`);
  } else {
    deps.io.outBinary(response.data);
  }
}

/**
 * Write `warning: <sentence>` to stderr when the effective base URL (`--base-url`, else
 * the default) is plain `http:` to a host other than the loopback interface
 * (`cleartextProblem`), naming the API key when one is sent. Called once per run,
 * after the options are parsed and before the first request; stdout and the exit code
 * are untouched.
 */
export function warnIfCleartext(deps: CliDeps, baseUrl: string | undefined, sendsKey: boolean): void {
  const problem = cleartextProblem(baseUrl ?? DEFAULT_BASE_URL, sendsKey ? [API_KEY_PHRASE] : []);
  if (problem !== undefined) deps.io.err(`warning: ${problem}`);
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
    // `-o -` means stdout: from here on it is the same as no -o.
    if (global.output === "-") delete global.output;
    const options = toEngineOptions(global);
    // flag > DIP_API_KEY > the credentials file (`dip config set api-key`) > none. The
    // file is read only here, when no key came from the first two, so a problem with
    // it never stands in the way of a key given another way.
    if (options.apiKey === undefined) {
      const stored = deps.credentials?.().get(API_KEY_CREDENTIAL);
      if (stored !== undefined) options.apiKey = stored;
    }
    const client = deps.createClient(options);
    // Built first, so a key the client rejects is a usage error before any warning.
    warnIfCleartext(deps, options.baseUrl, options.apiKey !== undefined);
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
