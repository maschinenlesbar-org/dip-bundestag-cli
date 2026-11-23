// The MCP server's test harness, the same in every repository (the kit): a config, a log
// recorder, an in-process MCP connection over the SDK's InMemoryTransport with raw JSON-RPC (so
// the tests see exactly what a client receives), and the HTTP server on a free port with a raw
// HTTP client. Nothing reaches the network: the upstream is always an injected transport.
// For an API with credentials (src/mcp/credentials.ts), the server sees helpers.ts's `TEST_ENV`
// (a test key) unless a test passes an `env` of its own; it never sees the real environment and
// never reads a credentials file. A test builds a client with `newClient` (helpers.ts's
// `TEST_CLIENT_OPTIONS` on top: a test login, for a client that refuses to be built without one).
// For a server that requires a bearer token over HTTP (src/mcp/auth.ts), every HTTP server the
// harness starts gets `--auth-token-file` with a test token, and `headers()` sends it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Transport } from "../src/mcp/api.js";
import { AUTH_TOKEN_REQUIRED } from "../src/mcp/auth.js";
import { createLogger, type Logger } from "@maschinenlesbar.org/dip-bundestag-log";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { parseConfig, type McpConfig } from "../src/mcp/config.js";
import { run } from "../src/mcp/run.js";
import { createServerFactory } from "../src/mcp/server.js";
import { PROGRAM } from "../src/mcp/version.js";
import * as helpers from "./helpers.js";

/** The environment the server sees in these tests: helpers.ts's `TEST_ENV`, if it exports one. */
export const TEST_ENV: Readonly<Record<string, string | undefined>> = (helpers as unknown as { TEST_ENV?: Record<string, string | undefined> }).TEST_ENV ?? {};

/** Client options every test client gets: helpers.ts's `TEST_CLIENT_OPTIONS`, if it exports them. */
const TEST_CLIENT_OPTIONS: Record<string, unknown> = (helpers as unknown as { TEST_CLIENT_OPTIONS?: Record<string, unknown> }).TEST_CLIENT_OPTIONS ?? {};

/** A client for a test, with `TEST_CLIENT_OPTIONS` under `options`. */
export function newClient(options: NonNullable<ConstructorParameters<typeof Client>[0]>): Client {
  return new Client({ ...TEST_CLIENT_OPTIONS, ...options } as NonNullable<ConstructorParameters<typeof Client>[0]>);
}

/** The bearer token of the harness's HTTP servers (written to a file of mode 600, removed at exit). */
export const TEST_AUTH_TOKEN = "test-bearer-token-0123456789abcdef0123456789";

let tokenFile: string | undefined;

/** A file holding `token` as the server wants it (mode 600), removed when the tests end. */
export function writeTokenFile(token: string = TEST_AUTH_TOKEN, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-token-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "token");
  writeFileSync(path, `${token}\n`, { mode });
  return path;
}

/** The arguments an HTTP server needs to start: `--auth-token-file` where a token is required. */
export function authArgs(): string[] {
  if (!AUTH_TOKEN_REQUIRED) return [];
  tokenFile ??= writeTokenFile();
  return ["--auth-token-file", tokenFile];
}

/** The default config with `overrides`. */
export function config(overrides: Partial<McpConfig> = {}): McpConfig {
  const parsed = parseConfig([]);
  if (parsed.kind !== "run") throw new Error("defaults don't parse");
  return { ...parsed.config, ...overrides };
}

/** A logger whose records land in `lines`, at time 0. */
export function recorder(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: createLogger({ program: PROGRAM, format: "text", write: (line) => lines.push(line), now: () => new Date(0) }) };
}

/** A tool call's result as a client receives it. */
export interface CallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Connection {
  /** Send a request; resolves with the whole JSON-RPC response. */
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The result of tools/call, or throws on a JSON-RPC error (the error as `rpc`). */
  call(name: string, args: Record<string, unknown>): Promise<CallResult>;
  initialize: Record<string, unknown>;
  close(): Promise<void>;
}

/** Connect to a server from the factory over InMemoryTransport, after the 2025-11-25 handshake. */
export async function connect(options: { transport: { transport: Transport }; config?: Partial<McpConfig>; log?: Logger; env?: Record<string, string | undefined> }): Promise<Connection> {
  const factory = createServerFactory({ config: config(options.config), transport: options.transport.transport, log: options.log ?? recorder().log, env: options.env ?? TEST_ENV });
  const [client, server] = InMemoryTransport.createLinkedPair();
  await factory().connect(server);
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const { id } = message as { id?: number };
    if (id !== undefined) pending.get(id)?.(message as Record<string, unknown>);
  };
  await client.start();
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = next++;
    const answer = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    return answer;
  };
  const initialize = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  return {
    request,
    initialize,
    async call(name, args) {
      const answer = await request("tools/call", { name, arguments: args });
      if (answer["error"] !== undefined) throw Object.assign(new Error(JSON.stringify(answer["error"])), { rpc: answer["error"] });
      return answer["result"] as CallResult;
    },
    close: () => client.close(),
  };
}

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw request: node:http, so the test can set Host (fetch can't). */
export function send(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/mcp", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

/** The JSON-RPC body of a 2025-06-18 `initialize`. */
export const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

/** The headers of an MCP POST to the server on `port`, with `extra`. */
export const headers = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  host: `127.0.0.1:${port}`,
  ...(AUTH_TOKEN_REQUIRED ? { authorization: `Bearer ${TEST_AUTH_TOKEN}` } : {}),
  ...extra,
});

/** A transport for tests that make no upstream request: any request fails the call. */
export const noUpstream: Transport = () => Promise.reject(new Error("this test makes no upstream request"));

/** The HTTP server started by `run`, on a free port: its port, its records, how to stop it and its exit code. */
export interface RunningServer {
  port: number;
  lines: string[];
  stop(): void;
  done: Promise<number>;
}

/** Start the server with `--transport http --port 0` and `argv`; resolves once it listens. */
export async function startHttp(argv: string[], options: { transport?: Transport; inContainer?: boolean; drainMs?: number; env?: Record<string, string | undefined> } = {}): Promise<RunningServer> {
  const lines: string[] = [];
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let listening: (port: number) => void = () => {};
  const port = new Promise<number>((resolve) => (listening = resolve));
  const auth = argv.includes("--auth-token-file") ? [] : authArgs();
  const done = run(["--transport", "http", "--port", "0", ...auth, ...argv], {
    stdout: () => {},
    stderr: (line) => lines.push(line),
    transport: options.transport ?? noUpstream,
    stopped,
    onListening: (server) => listening((server.address() as AddressInfo).port),
    inContainer: () => options.inContainer ?? false,
    env: options.env ?? TEST_ENV,
    ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
  });
  // A server that ends before it listens (a usage error) fails the test instead of hanging it.
  const listeningPort = await Promise.race([port, done.then((code) => Promise.reject(new Error(`the server ended with ${code} before listening: ${lines.join(" | ")}`)))]);
  return { port: listeningPort, lines, stop, done };
}

/** Run the HTTP server around `use`, stop it, check it ended with 0; returns its records. */
export async function withServer(argv: string[], use: (port: number) => Promise<void>, options: { inContainer?: boolean } = {}): Promise<string[]> {
  const server = await startHttp(argv, options);
  try {
    await use(server.port);
  } finally {
    server.stop();
    if ((await server.done) !== 0) throw new Error(`the server ended with ${await server.done}`);
  }
  return server.lines;
}
