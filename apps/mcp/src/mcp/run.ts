// argv -> exit code, testable: no process.exit, the streams, the upstream transport and the
// moments to stop come in as deps (index.ts passes the real ones).

import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { createLogger, type Logger } from "@maschinenlesbar.org/dip-bundestag-log";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { nodeHttpTransport, type Transport } from "./api.js";
import { readAuthTokenFile } from "./auth.js";
import { HELP, parseConfig, type McpConfig } from "./config.js";
import { redactingLog, Secrets } from "./credentials.js";
import { createHttpServer, isLoopback } from "./http.js";
import { limitTransport } from "./limiter.js";
import { createServerFactory } from "./server.js";
import { PROGRAM, VERSION } from "./version.js";

export const USAGE_EXIT = 2;

/** How long a stopping HTTP server waits for calls in flight before it cuts them off (ms). */
export const DRAIN_MS = 5000;

export interface RunDeps {
  stdout: (text: string) => void;
  /** One stderr line, without the newline. */
  stderr: (line: string) => void;
  /** The upstream transport (default: node:http). */
  transport?: Transport;
  /** Resolves when the server should stop: stdin's end on stdio, a signal. */
  stopped: Promise<void>;
  /** Called with the logger once the format is known (index.ts: Node's warnings). */
  onLogger?: (log: Logger) => void;
  /** Called with the HTTP server once it listens (tests read its port). */
  onListening?: (server: Server) => void;
  now?: () => Date;
  /** How long a stopping HTTP server waits for calls in flight (default DRAIN_MS). */
  drainMs?: number;
  /** On stdio: whether any input arrived before stdin ended (index.ts watches stdin). */
  stdinReceived?: () => boolean;
  /** True when running in a container (default: Docker's /.dockerenv or Podman's /run/.containerenv). */
  inContainer?: () => boolean;
  /** Where credentials are looked up, if the API needs them (credentials.ts): index.ts passes process.env; default none. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Whether the repository's credentials file may be read (index.ts only; default false). */
  credentialsFile?: boolean;
}

const inContainer = (): boolean => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const parsed = parseConfig(argv);
  if (parsed.kind === "help") {
    deps.stdout(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    deps.stdout(`${VERSION}\n`);
    return 0;
  }
  const format = parsed.kind === "run" ? parsed.config.logFormat : "text";
  let log = createLogger({ program: PROGRAM, format, write: deps.stderr, ...(deps.now === undefined ? {} : { now: deps.now }) });
  if (parsed.kind === "error") {
    log.error("mcp", `${parsed.message} See --help.`);
    return USAGE_EXIT;
  }
  const config = parsed.config;
  // HTTP with a bearer token (auth.ts): read once, before anything listens; never in a record.
  let authToken: string | undefined;
  if (config.authTokenFile !== undefined) {
    try {
      authToken = readAuthTokenFile(config.authTokenFile);
    } catch (err) {
      log.error("config", err instanceof Error ? err.message : String(err));
      return 1;
    }
    const secrets = new Secrets();
    secrets.add([authToken]);
    log = redactingLog(log, secrets);
  }
  deps.onLogger?.(log);
  if (config.baseUrl?.startsWith("http:") === true) {
    log.warn("http", `requests to ${config.baseUrl} are sent unencrypted (plain http).`);
  }
  const factory = createServerFactory({
    config,
    transport: limitTransport(deps.transport ?? nodeHttpTransport),
    log,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.credentialsFile === undefined ? {} : { credentialsFile: deps.credentialsFile }),
  });
  return config.transport === "stdio" ? serveOnStdio(factory, deps, log) : serveOnHttp(factory, config, deps, log, authToken);
}

async function serveOnStdio(factory: ReturnType<typeof createServerFactory>, deps: RunDeps, log: Logger): Promise<number> {
  const handle = serveStdio(factory);
  log.info("mcp", `${PROGRAM} ${VERSION} serving MCP on stdio`);
  await deps.stopped;
  await handle.close();
  if (deps.stdinReceived?.() === false) {
    // `docker run <image>` without -i closes stdin at once: the server would end, exit 0, unexplained.
    log.error(
      "mcp",
      "stdin ended before any MCP message: no client is connected on stdio. In a container, run it with docker run -i (an MCP client does); for HTTP use --transport http --host 0.0.0.0.",
    );
    return 1;
  }
  return 0;
}

async function serveOnHttp(factory: ReturnType<typeof createServerFactory>, config: McpConfig, deps: RunDeps, log: Logger, authToken: string | undefined): Promise<number> {
  const server = createHttpServer(factory, config, log, authToken);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (err) {
    log.error("http", `Could not listen on ${config.host}:${config.port}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  log.info("mcp", `${PROGRAM} ${VERSION} serving MCP on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}/mcp`);
  if (authToken !== undefined) log.info("http", `every request must send the bearer token from ${config.authTokenFile} (Authorization: Bearer …)`);
  if (isLoopback(config.host) && (deps.inContainer ?? inContainer)()) {
    // Docker forwards a published port to the container's own interface, never to its loopback.
    log.warn("http", `listening on ${config.host} inside a container: a published port (docker run -p) can't reach it. Add --host 0.0.0.0 to serve through the published port.`);
  }
  if (!isLoopback(config.host)) {
    // In a container the server can't see Docker's port mapping: `-p 127.0.0.1:…` keeps it local,
    // `-p 3000:3000` doesn't. Say both, without claiming which one this is.
    log.warn(
      "http",
      authToken === undefined
        ? `listening on ${config.host}: reachable from outside this container or machine, and the server has no authentication. Publish the port on 127.0.0.1 only (docker run -p 127.0.0.1:<host port>:${port}) or put an authenticating proxy in front.`
        : `listening on ${config.host}: reachable from outside this container or machine. The bearer token travels unencrypted over plain HTTP: publish the port on 127.0.0.1 only (docker run -p 127.0.0.1:<host port>:${port}) or put a TLS proxy in front.`,
    );
  }
  deps.onListening?.(server);
  await deps.stopped;
  // Drain: accept no new connection, close idle ones, let calls in flight answer, up to the drain time.
  const drainMs = deps.drainMs ?? DRAIN_MS;
  const calls = server.inFlight();
  if (calls > 0) log.info("mcp", `stopping: waiting up to ${drainMs / 1000} s for ${calls} call${calls === 1 ? "" : "s"} in flight`);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // A keep-alive connection that answered its call turns idle and would hold close() until the
  // keep-alive timeout: close every connection as soon as no call is in flight.
  const idle = setInterval(() => {
    if (server.inFlight() === 0) server.closeAllConnections();
  }, 25);
  const cutOff = setTimeout(() => server.closeAllConnections(), drainMs);
  await closed;
  clearInterval(idle);
  clearTimeout(cutOff);
  return 0;
}
