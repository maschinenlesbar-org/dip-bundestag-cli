// Streamable HTTP on node:http: the SDK's web-standard handler (createMcpHandler: the 2026-07-28
// revision and stateless 2025 serving) behind a small adapter that adds what the SDK leaves to
// the server:
//  - one endpoint, POST /mcp (the SDK answers GET and DELETE with 405); GET /healthz for
//    orchestrators; anything else 404;
//  - DNS-rebinding protection: the Host header must be an allowed name (default localhost,
//    127.0.0.1, [::1]), and an Origin, when a browser sends one, exactly one of --allowed-origins
//    (scheme, host and port; none by default: the server serves no pages); else 403. The SDK's
//    handler accepted a foreign Host and Origin, and its Origin helper compares host names only,
//    so a page on any localhost port passed.
//  - CORS for an allowed Origin only: its preflight (OPTIONS /mcp, which carries no token) is 204
//    with the methods and headers an MCP client sends, and every answer to it names the origin.
//  - limits: a body of at most 1 MiB (413), at most 8 requests at once (503; a request counts once
//    its body has arrived, so slow bodies lock no one out), explicit timeouts;
//  - a client that disconnects closes the McpServer serving its request, which aborts the tool
//    call (the SDK's own path, the web Request's signal, was lost once the garbage collector ran).
//  - with --auth-token-file (auth.ts), a bearer token on every POST /mcp: a request without it,
//    or with another, is 401 with `WWW-Authenticate: Bearer` and no detail. /healthz stays open.
// Without a token there is no authentication: the data is public and the tools only read. Exposed
// beyond localhost, such a server belongs behind a proxy that authenticates. A server whose API is
// called with a personal account refuses HTTP without a token (config.ts).

import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { Logger } from "@maschinenlesbar.org/dip-bundestag-log";
import { createMcpHandler, validateHostHeader, type McpServer } from "@modelcontextprotocol/server";
import { bearerMatches } from "./auth.js";
import type { McpConfig } from "./config.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ACTIVE_REQUESTS = 8;

/** What a browser on an allowed origin may send (a preflight asks), and read of the answer. */
const CORS_ALLOWED_HEADERS = "Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
const CORS_EXPOSED_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate";

/** The HTTP server, and how many MCP requests it is answering right now. */
export type McpHttpServer = http.Server & { inFlight(): number };

/** `authToken`: the bearer token every POST /mcp must send (auth.ts), or undefined for none. */
export function createHttpServer(factory: () => McpServer, config: McpConfig, log: Pick<Logger, "warn">, authToken?: string): McpHttpServer {
  // The default response mode answers with one JSON body unless a tool sends a message before its
  // result, which none does. ("json" made the SDK print a warning outside the log.)
  // The signal of the HTTP request being served: its McpServer closes when it aborts.
  const disconnected = new AsyncLocalStorage<AbortSignal>();
  const serverFor = (): McpServer => {
    const server = factory();
    disconnected.getStore()?.addEventListener("abort", () => void server.close().catch(() => {}), { once: true });
    return server;
  };
  const handler = createMcpHandler(serverFor, { onerror: (error) => log.warn("http", error.message) });
  const allowedOrigins = new Set(config.allowedOrigins);
  let active = 0;

  const server = http.createServer((req, res) => {
    void serve(req, res).catch((err: unknown) => {
      log.warn("http", `request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) plain(res, 500, "Internal error.\n");
      else res.destroy();
    });
  });

  async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?", 1)[0];
    if (path === "/healthz") return req.method === "GET" || req.method === "HEAD" ? plain(res, 200, "ok\n") : plain(res, 405, "Method not allowed.\n", { Allow: "GET" });
    if (path !== "/mcp") return plain(res, 404, "Not found. The MCP endpoint is POST /mcp.\n");
    const host = validateHostHeader(req.headers.host, config.allowedHosts);
    if (!host.ok) return rpcError(res, 403, "Forbidden: this Host is not allowed (--allowed-hosts).");
    // No Origin (not a browser) passes; `null`, anything not a URL and any other origin don't.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(originOf(origin))) {
      return rpcError(res, 403, "Forbidden: this Origin is not allowed (--allowed-origins).");
    }
    if (origin !== undefined) {
      // CORS, for an allowed origin only: without it a browser can't read the answer, and without
      // an answered preflight it doesn't even send its POST (Content-Type: application/json).
      res.setHeader("Access-Control-Allow-Origin", originOf(origin));
      res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS, "Access-Control-Max-Age": "600" });
        res.end();
        return;
      }
    }
    if (authToken !== undefined && !bearerMatches(req.headers.authorization, authToken)) {
      return rpcError(res, 401, "Unauthorized.", { "WWW-Authenticate": "Bearer" });
    }
    // A request takes a slot once its body is here: a body that trickles in (Node cuts it off only
    // at requestTimeout) holds its own connection, not a slot everyone else needs.
    const body = await readBody(req);
    if (body === undefined) return rpcError(res, 413, `The request body is larger than ${MAX_BODY_BYTES} bytes.`);
    if (active >= MAX_ACTIVE_REQUESTS) return rpcError(res, 503, "The server is busy; try again shortly.", { "Retry-After": "1" });
    active += 1;
    try {
      // A client that goes away before its answer cancels the call: closing its McpServer aborts
      // the call's signal. (The web Request's signal reaches the SDK through an undici clone that
      // holds its link weakly: after a garbage collection the abort no longer arrived.)
      const controller = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await disconnected.run(controller.signal, () =>
        handler.fetch(new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method ?? "GET", headers, signal: controller.signal, ...(hasBody ? { body } : {}) })),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body !== null) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } finally {
      active -= 1;
    }
  }

  // Long enough for a tool call under its deadline, short for headers and idle connections.
  server.requestTimeout = config.callTimeoutMs + 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return Object.assign(server, { inFlight: () => active });
}

/** The body, or undefined when it is over MAX_BODY_BYTES (the rest is not read). */
async function readBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function plain(res: http.ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

function rpcError(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers, Connection: "close" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** The origin of an Origin header value (scheme://host[:port], normalised), or "" for anything else. */
function originOf(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

/** True for an address only this machine reaches. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
