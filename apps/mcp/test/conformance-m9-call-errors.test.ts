// Conformance test M9 (MCP kit, rollout plan 2026-11-19): a failed call is a tool error a model
// can act on, never a protocol error and never a stack trace.
// - An upstream error names the request, and leaves a WARN record of `<program>.api` (or `.http`
//   for the transport) naming the tool; so does the call deadline (`.server`).
// - The call deadline (--call-timeout) stops a call that waits on the upstream, with advice to
//   narrow it; a cancelled call says so. At the deadline the call's signal aborts, and a tool that
//   answers with what it has read so far (a part, said so in its answer) gets that answer out.
// - A bug is a fixed text for the caller and an ERROR record of `<program>.server` with the details.
// - An answer over the server's size cap says what to ask instead, not a CLI option.
// - A retry's record names the wait the retry really has: the limiter's pause after a 429 too.
// Shared across the repos with an MCP server; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBase, Client, type Transport } from "../src/mcp/api.js";
import { limitTransport } from "../src/mcp/limiter.js";
import { callTool, type ToolDefinition } from "../src/mcp/server.js";
import { TOOLS } from "../src/mcp/tools.js";
import { PROGRAM } from "../src/mcp/version.js";
import { config, connect, recorder } from "./harness.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { jsonResponse, makeMockTransport } from "./helpers.js";
/** A tool call that makes at least one upstream request. */
const CALL = { name: "getRecord", arguments: { resource: "person", id: 1502 } };
// --------------------------------------------------------------------------------------

// A client for a test (harness.ts: with the repository's test login, where its client needs one).
const { newClient } = await import("./harness.js");

const tool = TOOLS.find((t) => t.name === CALL.name) as ToolDefinition;
// An upstream that never answers, but ends a request when its signal aborts, as the real
// transport does: a request left open would keep the client's request timer (30 s) alive
// after the test, and the file would take that long.
const hangUntilAborted = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
const hanging = makeMockTransport((request) => hangUntilAborted(request.signal));
// The client gets the limited transport, as in the server: it adds the call's signal to every request.
const env = (transport: Transport, overrides = {}) => {
  const { log, lines } = recorder();
  return { lines, env: { client: newClient({ transport: limitTransport(transport) }) as Client, apiBase: apiBase(undefined), config: config(overrides), log } };
};

test("an upstream error is a tool error naming the request", async () => {
  // A 500, not a 404: a tool may rightly answer a 404 as empty with a reason ("not published yet").
  const connection = await connect({ transport: makeMockTransport(() => jsonResponse({ error: "internal error" }, 500)) });
  const result = await connection.call(CALL.name, CALL.arguments);
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes(new URL(apiBase(undefined)).host), text);
  assert.match(text, /500/);
  assert.equal(result.structuredContent, undefined, "an error result carries text only");
  await connection.close();
});

test("an upstream failure and the call deadline leave a WARN record naming the tool", async () => {
  const { log, lines } = recorder();
  const connection = await connect({ transport: makeMockTransport(() => jsonResponse({ error: "internal error" }, 500)), log });
  await connection.call(CALL.name, CALL.arguments);
  await connection.close();
  assert.ok(lines.some((line) => new RegExp(`WARN  \\[${PROGRAM}\\.(api|http)\\] ${CALL.name}: .*500`).test(line)), lines.join("\n"));
  const { env: e, lines: deadlineLines } = env(hanging.transport, { callTimeoutMs: 30 });
  await callTool(tool, CALL.arguments, new AbortController().signal, e);
  assert.ok(deadlineLines.some((line) => line.includes(`WARN  [${PROGRAM}.server] ${CALL.name} stopped at the call deadline`)), deadlineLines.join("\n"));
});

test("the call deadline stops a call that waits on the upstream, with advice to narrow it", async () => {
  const { env: e } = env(hanging.transport, { callTimeoutMs: 30 });
  const result = await callTool(tool, CALL.arguments, new AbortController().signal, e);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /^The call took longer than 0 s and was stopped\. \S/);
});

test("at the deadline a tool that keeps what it has read answers with that part", async () => {
  const { env: e } = env(hanging.transport, { callTimeoutMs: 30 });
  const keeping: ToolDefinition = {
    ...tool,
    run: async (_args, context) => {
      try {
        // Page 1 was read; page 2 waits until the call's signal aborts it.
        await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return { status: "ok", pages: ["page 1", "page 2"] };
      } catch {
        return { status: "ok", pages: ["page 1"], complete: false };
      }
    },
  };
  const result = await callTool(keeping, CALL.arguments, new AbortController().signal, e);
  assert.notEqual(result.isError, true, result.content[0]?.text);
  assert.deepEqual(result.structuredContent?.["pages"], ["page 1"]);
  assert.equal(result.structuredContent?.["complete"], false);
});

test("the deadline stops a call even when the tool's code ignores the signal", async () => {
  const { env: e } = env(hanging.transport, { callTimeoutMs: 30 });
  const deaf: ToolDefinition = { ...tool, run: () => new Promise(() => {}) };
  const result = await callTool(deaf, CALL.arguments, new AbortController().signal, e);
  assert.match(result.content[0]?.text ?? "", /^The call took longer than 0 s and was stopped\./);
});

test("a request of a call that ignores the signal still carries it, and none is sent after the abort", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const recording: Transport = (request) => {
    seen.push(request.signal);
    return hangUntilAborted(request.signal);
  };
  const { env: e } = env(recording, { callTimeoutMs: 30 });
  const deaf: ToolDefinition = { ...tool, run: (args, context) => tool.run(args, { ...context, signal: new AbortController().signal }) };
  await callTool(deaf, CALL.arguments, new AbortController().signal, e);
  assert.ok(seen.length >= 1 && seen.every((signal) => signal?.aborted === true), "every request's signal aborted with the call");
});

test("a cancelled call says so", async () => {
  const { env: e } = env(hanging.transport);
  const controller = new AbortController();
  const pending = callTool(tool, CALL.arguments, controller.signal, e);
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, "The call was cancelled.");
});

test("a bug is a fixed text for the caller and an ERROR record with the details", async () => {
  const { env: e, lines } = env(hanging.transport);
  const broken: ToolDefinition = { ...tool, run: () => Promise.reject(new TypeError("secret detail")) };
  const result = await callTool(broken, {}, new AbortController().signal, e);
  assert.equal(result.content[0]?.text, `${tool.name} failed with an internal error; the server's log has the details.`);
  assert.ok(lines.join("\n").includes(`ERROR [${PROGRAM}.server] ${tool.name} failed: TypeError: secret detail`), lines.join("\n"));
});

test("an answer over the server's size cap is a tool error that says what to ask instead, not a CLI option", async () => {
  const huge = makeMockTransport(() => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.alloc(17 * 1024 * 1024, 0x20) }));
  const connection = await connect({ transport: huge });
  const result = await connection.call(CALL.name, CALL.arguments);
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.doesNotMatch(text, /--max-response-bytes|on the CLI/);
  assert.match(text, /is larger than this server accepts \(16 MiB\)\. \S/);
  await connection.close();
});

test("a result's source is the tool's path under the API's base, made from the arguments and the base; an absolute URL (an API on a second host) is used as it is", async () => {
  const { env: e } = env(hanging.transport);
  const sourceOf = async (source: ToolDefinition["source"]): Promise<unknown> => {
    const probe: ToolDefinition = { ...tool, source, run: async () => ({ status: "ok" }) };
    return (await callTool(probe, { id: "a b" }, new AbortController().signal, { ...e, apiBase: "https://api.example/v1" })).structuredContent?.["source"];
  };
  assert.equal(await sourceOf("items"), "https://api.example/v1/items");
  assert.equal(await sourceOf((args) => `items/${String(args["id"])}`), "https://api.example/v1/items/a b");
  assert.equal(await sourceOf((_args, base) => `${base.replace("api.", "files.")}/feed.json`), "https://files.example/v1/feed.json");
  assert.equal(await sourceOf(() => "http://other.example/feed.json"), "http://other.example/feed.json");
});

test("a retry's record names the wait the limiter holds it for, not only the engine's backoff", async () => {
  let first = true;
  const upstream = makeMockTransport(() => (first ? ((first = false), { status: 429, headers: {}, body: Buffer.from("") }) : jsonResponse({}, 500)));
  const { log, lines } = recorder();
  const connection = await connect({ transport: { transport: limitTransport(upstream.transport) }, config: { callTimeoutMs: 300 }, log });
  await connection.call(CALL.name, CALL.arguments);
  await connection.close();
  const retry = lines.find((line) => line.includes(`[${PROGRAM}.http] retry 1/`));
  assert.ok(retry !== undefined, lines.join("\n"));
  const waited = Number(/ in (\d+) ms/.exec(retry)?.[1]);
  assert.ok(waited > 4000, `the limiter holds every start for 5 s after a 429 without Retry-After: ${retry}`);
});

// An HTTP client that goes away (its connection closes before the answer) cancels its call: the
// upstream request in flight is aborted, the call ends and gives its request slot back. The SDK's
// handler only learnt of it through the web Request's signal, which stopped following the
// server's once the garbage collector ran: the call went on to the end, every request included.
test("an HTTP client that goes away cancels its call: the upstream request is aborted", async () => {
  const { headers, startHttp } = await import("./harness.js");
  const http = await import("node:http");
  const v8 = await import("node:v8");
  const vm = await import("node:vm");
  v8.setFlagsFromString("--expose-gc");
  const collectGarbage = vm.runInNewContext("gc") as () => void;
  let reached: () => void = () => {};
  const upstream = new Promise<void>((resolve) => (reached = resolve));
  let aborted: () => void = () => {};
  const cancelled = new Promise<string>((resolve) => (aborted = () => resolve("aborted")));
  const { transport } = makeMockTransport((request) => {
    reached();
    request.signal?.addEventListener("abort", () => aborted(), { once: true });
    return hangUntilAborted(request.signal);
  });
  // A deadline of 2 s: without the cancellation the call would end there, after the 1 s looked for.
  const server = await startHttp(["--call-timeout", "2000"], { transport });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: CALL });
    const req = http.request({ host: "127.0.0.1", port: server.port, path: "/mcp", method: "POST", headers: { ...headers(server.port), "mcp-protocol-version": "2025-06-18", "content-length": String(Buffer.byteLength(body)) } });
    req.on("error", () => {});
    req.end(body);
    await upstream;
    // A moment first: what the current job has touched stays alive until it ends.
    await new Promise((resolve) => setTimeout(resolve, 20));
    collectGarbage();
    req.destroy();
    const outcome = await Promise.race([cancelled, new Promise<string>((resolve) => setTimeout(() => resolve("still running after 1 s"), 1000))]);
    assert.equal(outcome, "aborted");
  } finally {
    server.stop();
    await server.done;
  }
});

// On stdio, the end of stdin (a client that wrote its requests and closed the pipe) stops the
// server only after the calls it has read are answered; the SDK's transport closed at once and
// dropped them, with exit 0 and nothing in the log.
test("on stdio, a call still running when stdin ends is answered before the server stops", async () => {
  const { PassThrough } = await import("node:stream");
  const { run } = await import("../src/mcp/run.js");
  const { TEST_ENV } = await import("./harness.js");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const lines: string[] = [];
  // As index.ts: the server stops when stdin ends.
  const stopped = new Promise<void>((resolve) => stdin.once("end", () => resolve()));
  // An upstream that answers a moment later, with an error: the call's answer is a tool error.
  const slow = makeMockTransport(() => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ error: "internal error" }, 500)), 50)));
  const done = run(["--call-timeout", "2000"], { stdout: () => {}, stderr: (line) => lines.push(line), stopped, transport: slow.transport, env: TEST_ENV, stdio: { stdin, stdout } });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: CALL };
  stdin.end([initialize, initialized, call].map((message) => `${JSON.stringify(message)}\n`).join(""));
  assert.equal(await done, 0, lines.join("\n"));
  const answers = out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
  assert.ok(answers.some((answer) => answer.id === 2 && answer.result !== undefined), out);
  assert.ok(lines.some((line) => line.includes(`INFO  [${PROGRAM}.mcp] stdin ended: answering 1 request still running first`)), lines.join("\n"));
});
