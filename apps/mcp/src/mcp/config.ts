// The server's options, parsed with node:util's parseArgs (no commander: the MCP app has no
// runtime dependency besides the MCP SDK). Every value is checked here, before anything starts:
// the client's own rules for the base URL, whole numbers within bounds, a known log format.

import { parseArgs } from "node:util";
import { DEFAULT_LOG_FORMAT, logFormatProblem, type LogFormat } from "@maschinenlesbar.org/dip-bundestag-log";
import { baseUrlProblem, DEFAULT_BASE_URL, MAX_TIMEOUT_MS } from "./api.js";
import { DESCRIPTION, PROGRAM } from "./version.js";

export interface McpConfig {
  transport: "stdio" | "http";
  host: string;
  port: number;
  /** Host header names the HTTP server answers to; default: localhost, 127.0.0.1, [::1]. */
  allowedHosts: string[];
  /** Browser origins (scheme://host[:port]) that may call; none by default. */
  allowedOrigins: string[];
  baseUrl: string | undefined;
  /** Per upstream request, whole response included (ms). */
  timeoutMs: number;
  /** Per tool call, every request and retry included (ms). */
  callTimeoutMs: number;
  maxResultChars: number;
  maxPages: number;
  userAgent: string | undefined;
  logFormat: LogFormat;
}

export type ParsedArgs = { kind: "run"; config: McpConfig } | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 3000,
  timeoutMs: 30_000,
  callTimeoutMs: 45_000,
  maxResultChars: 25_000,
  maxPages: 10,
} as const;

export const HELP = `Usage: ${PROGRAM} [options]

${wrap(DESCRIPTION, 92)}

Options:
  --transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
  --host <address>           HTTP: the address to listen on (default ${DEFAULTS.host}); anything
                             but loopback exposes the server, which has no authentication
  --port <n>                 HTTP: the port (default ${DEFAULTS.port})
  --allowed-hosts <list>     HTTP: Host header names to answer, comma-separated
                             (default localhost,127.0.0.1,[::1])
  --allowed-origins <list>   HTTP: browser origins allowed to call, comma-separated, exactly as
                             the browser sends them (https://app.example.org,
                             http://localhost:6274); none by default
  --base-url <url>           API base URL (default ${DEFAULT_BASE_URL})
  --timeout <ms>             per upstream request, whole response included (default ${DEFAULTS.timeoutMs})
  --call-timeout <ms>        per tool call, retries included (default ${DEFAULTS.callTimeoutMs})
  --max-result-chars <n>     cap on one tool result's JSON (default ${DEFAULTS.maxResultChars})
  --max-pages <n>            pages a tool reads per list and call (default ${DEFAULTS.maxPages})
  --user-agent <ua>          User-Agent header value
  --log-format <text|jsonl>  the records on stderr (default text)
  -h, --help                 show this help
  -V, --version              show the version
`;

/** `text` in lines of at most `width` characters, broken at spaces. */
function wrap(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  return [...lines, line].join("\n");
}

/** Parse argv; never throws. */
export function parseConfig(argv: readonly string[]): ParsedArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        transport: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "allowed-hosts": { type: "string" },
        "allowed-origins": { type: "string" },
        "base-url": { type: "string" },
        timeout: { type: "string" },
        "call-timeout": { type: "string" },
        "max-result-chars": { type: "string" },
        "max-pages": { type: "string" },
        "user-agent": { type: "string" },
        "log-format": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    }));
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (values["help"] === true) return { kind: "help" };
  if (values["version"] === true) return { kind: "version" };
  try {
    const str = (name: string): string | undefined => values[name] as string | undefined;
    const transport = str("transport") ?? "stdio";
    if (transport !== "stdio" && transport !== "http") throw new Error(`--transport must be stdio or http, got ${JSON.stringify(transport)}.`);
    const logFormat = str("log-format") ?? DEFAULT_LOG_FORMAT;
    const formatProblem = logFormatProblem(logFormat);
    if (formatProblem !== undefined) throw new Error(`--log-format: ${formatProblem}`);
    const baseUrl = str("base-url");
    if (baseUrl !== undefined) {
      const problem = baseUrlProblem(baseUrl);
      if (problem !== undefined) throw new Error(`--base-url: ${problem}`);
      const url = new URL(baseUrl);
      // A server runs for others: a credential in its upstream URL would be one every caller uses.
      if (url.username !== "" || url.password !== "") throw new Error("--base-url must not carry a user name or password.");
    }
    const userAgent = str("user-agent");
    if (userAgent !== undefined && (userAgent.trim() === "" || /[\u0000-\u001f\u007f]/.test(userAgent))) {
      throw new Error("--user-agent must be visible text on one line.");
    }
    const host = str("host") ?? DEFAULTS.host;
    if (host.trim() === "" || /\s/.test(host)) throw new Error(`--host must be an address, got ${JSON.stringify(host)}.`);
    return {
      kind: "run",
      config: {
        transport,
        host,
        port: wholeNumber("--port", str("port"), DEFAULTS.port, 0, 65535),
        allowedHosts: list("--allowed-hosts", str("allowed-hosts")) ?? ["localhost", "127.0.0.1", "[::1]"],
        allowedOrigins: origins("--allowed-origins", str("allowed-origins")) ?? [],
        baseUrl,
        timeoutMs: wholeNumber("--timeout", str("timeout"), DEFAULTS.timeoutMs, 0, MAX_TIMEOUT_MS),
        callTimeoutMs: wholeNumber("--call-timeout", str("call-timeout"), DEFAULTS.callTimeoutMs, 1000, MAX_TIMEOUT_MS),
        maxResultChars: wholeNumber("--max-result-chars", str("max-result-chars"), DEFAULTS.maxResultChars, 1000, 10_000_000),
        maxPages: wholeNumber("--max-pages", str("max-pages"), DEFAULTS.maxPages, 1, 100),
        userAgent,
        logFormat: logFormat as LogFormat,
      },
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function wholeNumber(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

/** Comma-separated origins (http or https, a host, an optional port, nothing else), normalised. */
function origins(name: string, value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((item) => {
    const text = item.trim();
    let url: URL | undefined;
    try {
      url = new URL(text);
    } catch {
      url = undefined;
    }
    const bare = url !== undefined && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "" && !text.endsWith("/");
    if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:") || !bare) {
      throw new Error(`${name} must be comma-separated origins such as https://app.example.org or http://localhost:6274, got ${JSON.stringify(item)}.`);
    }
    return url.origin;
  });
}

function list(name: string, value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim().toLowerCase());
  if (items.some((item) => item === "" || /[\s/]/.test(item))) throw new Error(`${name} must be comma-separated host names, got ${JSON.stringify(value)}.`);
  return items;
}
