// Conformance test M9 (MCP kit, rollout plan 2026-11-19): a failed call is a tool error a model
// can act on, never a protocol error and never a stack trace.
// - An upstream error names the request.
// - The call deadline (--call-timeout) stops a call that waits on the upstream, with advice to
//   narrow it; a cancelled call says so.
// - A bug is a fixed text for the caller and an ERROR record of `<program>.server` with the details.
// - An answer over the server's size cap says what to ask instead, not a CLI option.
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

const tool = TOOLS.find((t) => t.name === CALL.name) as ToolDefinition;
const hanging = makeMockTransport(() => new Promise(() => {}));
const env = (transport: Transport, overrides = {}) => {
  const { log, lines } = recorder();
  return { lines, env: { client: new Client({ transport }), apiBase: apiBase(undefined), config: config(overrides), log } };
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

test("the call deadline stops a call that waits on the upstream, with advice to narrow it", async () => {
  const { env: e } = env(hanging.transport, { callTimeoutMs: 30 });
  const result = await callTool(tool, CALL.arguments, new AbortController().signal, e);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /^The call took longer than 0 s and was stopped\. \S/);
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
    return new Promise(() => {});
  };
  const { env: e } = env(limitTransport(recording), { callTimeoutMs: 30 });
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
