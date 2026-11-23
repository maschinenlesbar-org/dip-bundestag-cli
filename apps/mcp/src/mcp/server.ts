// The MCP server: a factory of McpServer instances (the SDK asks for one per HTTP request and
// one per stdio connection), with the tools of tools.ts and the server instructions. Each tool
// call runs under a deadline (`--call-timeout`) and the client's cancellation; at the deadline its
// signal aborts and the tool has a moment to answer with what it has read; its answer is
// cleaned and fitted (result.ts) and sent as structuredContent with the same JSON as text. A
// failure is a tool result with isError and a message saying what to change, never a protocol
// error (an unknown tool or malformed call is the SDK's -32602); an upstream failure and the
// deadline are also a WARN record, a bug an ERROR record.
//
// The same in every repository (the kit): what is particular to this one is in tools.ts (the
// tools, the instructions, the licence) and api.ts (how to reach the client).

import type { Logger } from "@maschinenlesbar.org/dip-bundestag-log";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { apiBase, Client, ClientError, cutText, NetworkError, sizeLimitMessage, type Transport } from "./api.js";
import type { McpConfig } from "./config.js";
import { findCredentials, redactingLog, Secrets } from "./credentials.js";
import { callScope, type LimitedTransport } from "./limiter.js";
import { cleanStrings, fitResult } from "./result.js";
import { DEADLINE_HINT, INSTRUCTIONS, LICENCE, SIZE_HINT, TITLE, TOOLS } from "./tools.js";
import { PROGRAM, USER_AGENT, VERSION } from "./version.js";

export { INSTRUCTIONS, LICENCE } from "./tools.js";

export type JsonSchema = Record<string, unknown>;

/** What a tool's `run` gets besides its arguments. */
export interface ToolContext {
  client: Client;
  /**
   * Aborts at the call's deadline or when the caller cancels: pass it to every request. After the
   * deadline the tool has a moment (DEADLINE_GRACE_MS, at most a tenth of the call's time) to
   * answer with what it has read, saying it is a part; a cancelled call's answer is not awaited.
   */
  signal: AbortSignal;
  /** `--max-pages`: the most pages a tool reads per collection. */
  maxPages: number;
  /** The API's base URL (api.ts), for `source`. */
  apiBase: string;
}

/** One tool: its definition as clients see it, and what it does. */
export interface ToolDefinition {
  /** camelCase, letters only. */
  name: string;
  title: string;
  /** At most 2000 characters: trigger phrases first, then the traps, then the rules. */
  description: string;
  /** Flat: type object, properties, required, additionalProperties false; a limit on every field. */
  inputSchema: JsonSchema;
  /** One object schema with status, source and licence. */
  outputSchema: JsonSchema;
  /**
   * The path under the API's base the answer comes from (`source`), or how to make it from the
   * arguments and that base. An absolute URL (an API on a second host) is used as it is.
   */
  source: string | ((args: Record<string, unknown>, apiBase: string) => string);
  /** For a paged list: which list `nextOffset` counts, and where the page began. */
  paged?: (args: Record<string, unknown>) => { list: string; offset: number };
  run(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

/** Every tool reads only; none changes anything anywhere; all reach an outside service. */
export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

/** The largest upstream answer the server reads (the client's maxResponseBytes). */
export const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;

/** The longest a tool may take after the deadline to answer with what it has read (ms). */
export const DEADLINE_GRACE_MS = 1000;

/** The longest error message a tool result carries. */
const MAX_ERROR_MESSAGE = 5000;

export interface ServerDeps {
  config: McpConfig;
  /** The transport every client uses: the limited one (limiter.ts), shared across calls; a plain one in some tests. */
  transport: Transport;
  log: Logger;
  /** Where credentials are looked up (credentials.ts): index.ts passes process.env; default none. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Whether the repository's credentials file may be read (index.ts only; default false). */
  credentialsFile?: boolean;
}

/** The tools' names, titles and descriptions, without starting anything (docs, tests). */
export function listTools(): { name: string; title: string; description: string }[] {
  return TOOLS.map(({ name, title, description }) => ({ name, title, description }));
}

export function createServerFactory(deps: ServerDeps): () => McpServer {
  const { config } = deps;
  // Credentials found later (credentials.ts) are secrets: out of every record, result and error.
  const secrets = new Secrets();
  const log = redactingLog(deps.log, secrets);
  const userAgent = config.userAgent ?? USER_AGENT;
  // A retry waits for the limiter's pause after a 429 too (limiter.ts), whatever the engine's backoff.
  const pausedFor = (deps.transport as Partial<LimitedTransport>).pausedFor ?? (() => 0);
  const options: NonNullable<ConstructorParameters<typeof Client>[0]> = {
    transport: deps.transport,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    timeoutMs: config.timeoutMs,
    userAgent,
    maxResponseBytes: MAX_UPSTREAM_BYTES,
    onRetry: (event) => log.warn("http", `retry ${event.retry}/${event.maxRetries} of ${event.url} in ${Math.max(event.delayMs, pausedFor())} ms${event.status === undefined ? "" : ` (HTTP ${event.status})`}`),
    onWarning: (message) => log.warn("api", message),
  };
  const client = findCredentials === undefined ? new Client(options) : lazyClient(findCredentials);
  const base = apiBase(config.baseUrl);

  /**
   * The client once its credentials are found (credentials.ts): looked up at the first call that
   * needs it, shared by the calls after it; a lookup that fails is tried again at the next call.
   */
  function lazyClient(find: NonNullable<typeof findCredentials>): () => Promise<Client> {
    return shareLookup(() =>
      find({
        env: deps.env ?? {},
        credentialsFile: deps.credentialsFile ?? false,
        transport: deps.transport,
        timeoutMs: config.timeoutMs,
        userAgent,
        maxResponseBytes: MAX_UPSTREAM_BYTES,
      }).then(
        (found) => {
          secrets.add(found.secrets);
          log.info("config", `using ${found.source}`);
          return new Client({ ...options, ...(found.clientOptions as object) });
        },
        (err: unknown) => {
          log.warn("config", `no credentials yet (tried again at the next call): ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        },
      ),
    );
  }
  return () => {
    const server = new McpServer({ name: PROGRAM, version: VERSION, title: TITLE }, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema as never),
          outputSchema: fromJsonSchema(tool.outputSchema as never),
          annotations: ANNOTATIONS,
        },
        async (args: unknown, ctx: { mcpReq: { signal: AbortSignal } }) =>
          callTool(tool, (args ?? {}) as Record<string, unknown>, ctx.mcpReq.signal, { client, apiBase: base, config, log, secrets }),
      );
    }
    return server;
  };
}

/**
 * `look`, run at the first call and shared by the calls after it; one that fails is run again at
 * the next call. It runs outside every tool call's scope (limiter.ts): its requests carry no call's
 * signal, so the call that started it can't fail the others waiting for it by being cancelled or
 * reaching its deadline. Each call still stops waiting at its own (callTool's race); the lookup is
 * bounded by its own request timeout.
 */
export function shareLookup<T>(look: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= callScope.exit(look).catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

/** Run one tool under the deadline and the caller's signal; shape its answer or its error. */
export async function callTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  cancelled: AbortSignal,
  env: {
    /** The client, or how to get it once its credentials are found (credentials.ts). */
    client: Client | (() => Promise<Client>);
    apiBase: string;
    config: McpConfig;
    /** The server's log: the factory passes one that takes the secrets out (credentials.ts). */
    log: Pick<Logger, "error" | "warn" | "info">;
    /** Taken out of the result and the error message (credentials.ts); default none. */
    secrets?: Secrets;
  },
): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }> {
  // A timer of our own, not AbortSignal.timeout: that one's timer doesn't keep the process
  // alive, so a call waiting on nothing else (Node 22) would end the process instead of the call.
  const timer = new AbortController();
  const deadline = timer.signal;
  const stopAt = setTimeout(() => timer.abort(), env.config.callTimeoutMs);
  const signal = AbortSignal.any([cancelled, deadline]);
  try {
    // Inside callScope, every request of the call carries its signal, and none waits in the limiter
    // past the deadline (limiter.ts); the race ends the call at the deadline even when the client's
    // code still waits (a retry's backoff).
    const answer = await callScope.run({ signal, endsAt: Date.now() + env.config.callTimeoutMs }, () =>
      untilAborted(
        (async () => {
          const client = typeof env.client === "function" ? await env.client() : env.client;
          return tool.run(args, { client, signal, maxPages: env.config.maxPages, apiBase: env.apiBase });
        })(),
        cancelled,
        deadline,
        Math.min(DEADLINE_GRACE_MS, Math.ceil(env.config.callTimeoutMs / 10)),
      ),
    );
    const path = typeof tool.source === "function" ? tool.source(args, env.apiBase) : tool.source;
    const source = /^https?:\/\//.test(path) ? path : `${env.apiBase}/${path}`;
    const redacted = env.secrets === undefined ? answer : env.secrets.redactAll(answer);
    const shaped = fitResult(cleanStrings({ ...redacted, source, licence: LICENCE }), env.config.maxResultChars, tool.paged?.(args));
    return { content: [{ type: "text", text: JSON.stringify(shaped) }], structuredContent: shaped };
  } catch (err) {
    const redact = env.secrets?.redact ?? ((text: string) => text);
    if (deadline.aborted && !cancelled.aborted) {
      env.log.warn("server", `${tool.name} stopped at the call deadline (${env.config.callTimeoutMs} ms)`);
      return errorResult(`The call took longer than ${Math.round(env.config.callTimeoutMs / 1000)} s and was stopped. ${DEADLINE_HINT}`);
    }
    if (err instanceof NetworkError && cancelled.aborted) return errorResult("The call was cancelled.");
    // The client's size-cap text names the CLI's option, which a model calling this server can't use.
    if (err instanceof NetworkError && err.message.includes(sizeLimitMessage(MAX_UPSTREAM_BYTES))) {
      env.log.warn("http", `${tool.name}: ${redact(err.message)}`);
      return errorResult(`The answer from ${TITLE} is larger than this server accepts (${MAX_UPSTREAM_BYTES / 1024 / 1024} MiB). ${SIZE_HINT}`);
    }
    if (err instanceof ClientError) {
      // An operator sees why calls fail: the upstream's error (api), or the transport's (http).
      env.log.warn(err instanceof NetworkError ? "http" : "api", `${tool.name}: ${redact(err.message)}`);
      return errorResult(redact(err.message));
    }
    // A bug, not an answer: the details go to the log, the caller gets a fixed text.
    env.log.error("server", `${tool.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return errorResult(`${tool.name} failed with an internal error; the server's log has the details.`);
  } finally {
    clearTimeout(stopAt);
  }
}

/**
 * `promise`, unless `cancelled` aborts first, or `deadline` and then `graceMs` pass (time for the
 * tool to answer with what it has): then a rejection with the client's network error.
 */
function untilAborted<T>(promise: Promise<T>, cancelled: AbortSignal, deadline: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let grace: NodeJS.Timeout | undefined;
    const stop = (): void => reject(new NetworkError("aborted"));
    const onDeadline = (): void => {
      grace ??= setTimeout(stop, graceMs);
    };
    cancelled.addEventListener("abort", stop, { once: true });
    deadline.addEventListener("abort", onDeadline, { once: true });
    if (cancelled.aborted) stop();
    else if (deadline.aborted) onDeadline();
    promise.then(resolve, reject).finally(() => {
      clearTimeout(grace);
      cancelled.removeEventListener("abort", stop);
      deadline.removeEventListener("abort", onDeadline);
    });
  });
}

function errorResult(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  const cut = cutText(message, MAX_ERROR_MESSAGE);
  return { content: [{ type: "text", text: cleanStrings(cut.length < message.length ? `${cut}…` : message) }], isError: true };
}
