// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the two result-rendering paths (JSON and raw download).

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { RawResponse } from "../client/engine.js";
import type { DipClientOptions } from "../client/client.js";

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
 * commander value-parser: a value that is not blank. A blank filter would
 * otherwise be dropped and the command would silently run unfiltered.
 */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/** Build a commander value-parser for a plain decimal integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer between ${min} and ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser: an absolute http(s) URL. A `file:`/`ftp:` or malformed
 * --base-url is a usage error here rather than reaching the request engine.
 */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidArgumentError(
      `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`,
    );
  }
  // Paths are appended to the base URL as a string, so a query or fragment would
  // swallow every request path ("http://h/#f" requests "/" for every command).
  if (/[?#]/.test(value)) {
    throw new InvalidArgumentError("A base URL cannot have a query (?) or fragment (#).");
  }
  // new URL() trims surrounding whitespace silently; the raw value is what the
  // engine uses, so reject it rather than guess.
  if (value !== value.trim()) {
    throw new InvalidArgumentError("A base URL cannot have surrounding whitespace.");
  }
  // The client adds /api/v1 itself; the API's documented address ends in it, so
  // passing that would request /api/v1/api/v1/... and fail with a 404.
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api/v1")) {
    // (url.origin carries no userinfo, so nothing secret is echoed.)
    const suggestion = `${url.origin}${path.slice(0, -"/api/v1".length)}`;
    throw new InvalidArgumentError(
      `Leave out /api/v1: the base URL is the host, and the CLI adds /api/v1 itself (try ${suggestion}).`,
    );
  }
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
  // A blank --api-key is rejected at parse time and a blank DIP_API_KEY is
  // treated as unset (readEnvApiKey), so this guard only keeps a malformed
  // `Authorization: ApiKey ` header impossible. No key is bundled: when none is
  // supplied the header is omitted entirely and the API answers 401.
  if (global.apiKey !== undefined && global.apiKey.trim().length > 0) {
    options.apiKey = global.apiKey.trim();
  }
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  // Likewise, a blank --user-agent falls back to the engine's default UA rather
  // than sending an empty User-Agent header.
  if (global.userAgent !== undefined && global.userAgent.trim().length > 0) {
    options.userAgent = global.userAgent;
  }
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
 * Render a JSON value, pretty by default and compact with --compact. Writes to
 * the file given by --output (with a short stderr confirmation so stdout stays
 * clean for piping), or to stdout otherwise. An existing file is not overwritten
 * unless --force is set.
 */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
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
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
