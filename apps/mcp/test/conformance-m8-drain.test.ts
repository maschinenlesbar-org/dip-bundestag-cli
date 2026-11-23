// Conformance test M8 (MCP kit, rollout plan 2026-11-19, decision D4 of the container round):
// stopping the HTTP server (SIGTERM, `docker stop`) drains.
// - A call in flight still gets its answer, then the server ends, without waiting out the drain
//   time; an INFO record says how many calls it waits for.
// - The drain is bounded: a call that doesn't finish is cut off after the drain time.
// A test stops its server when it ends, whatever the outcome: a failed or timed-out test would
// otherwise leave it listening, and `node --test` waiting for it.
// Shared across the repos with an MCP server; only the adapter differs.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "../src/mcp/api.js";
import { PROGRAM } from "../src/mcp/version.js";
import { headers, send, startHttp } from "./harness.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { jsonResponse, PERSON_1502 } from "./helpers.js";
/** A tool call, and the upstream's answer to every request it makes. */
const CALL = { name: "getRecord", arguments: { resource: "person", id: 1502 } };
const ANSWER = (_request: HttpRequest): HttpResponse => jsonResponse(PERSON_1502);
// --------------------------------------------------------------------------------------

/**
 * Run the HTTP server with an upstream that answers after `delayMs` (or never). `reached`
 * resolves when the call's first request reaches the upstream: the call is in flight then, on a
 * slow machine too (a fixed wait raced the request on CI's Linux runners). The server stops when
 * the test `t` ends (stopping twice is no harm).
 */
async function slowServer(t: TestContext, delayMs: number | undefined, drainMs: number) {
  let reachedNow = (): void => {};
  const reached = new Promise<void>((resolve) => (reachedNow = resolve));
  const transport = (request: HttpRequest) =>
    new Promise<HttpResponse>((resolve, reject) => {
      reachedNow();
      if (delayMs !== undefined) setTimeout(() => resolve(ANSWER(request)), delayMs);
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const server = await startHttp([], { transport, drainMs });
  t.after(async () => {
    server.stop();
    await server.done;
  });
  return { ...server, reached };
}

const call = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: CALL.name, arguments: CALL.arguments } });

test("stopping drains: a call in flight still gets its answer, then the server ends", async (t) => {
  const server = await slowServer(t, 300, 5000);
  const answer = send(server.port, { headers: headers(server.port), body: call });
  await server.reached;
  const stoppedAt = Date.now();
  server.stop();
  const result = await answer;
  assert.equal(result.status, 200);
  // One JSON body, or (the SDK's choice for a call) one server-sent event carrying it.
  const json = result.body.startsWith("{") ? result.body : (result.body.split("\n").find((line) => line.startsWith("data: ")) ?? "").slice("data: ".length);
  const rpc = JSON.parse(json) as { result?: { isError?: boolean; structuredContent?: unknown } };
  assert.ok(rpc.result?.structuredContent !== undefined && rpc.result.isError !== true, result.body);
  assert.equal(await server.done, 0);
  assert.ok(Date.now() - stoppedAt < 2000, "ends once the call is answered, not after the whole drain time");
  assert.ok(server.lines.some((line) => line.includes(`INFO  [${PROGRAM}.mcp] stopping: waiting up to 5 s for 1 call in flight`)), server.lines.join("\n"));
});

test("the drain is bounded: a call that doesn't finish is cut off after the drain time", async (t) => {
  const server = await slowServer(t, undefined, 200);
  const cut = send(server.port, { headers: headers(server.port), body: call }).then(
    () => "answered",
    (err: Error) => err.message,
  );
  await server.reached;
  const stoppedAt = Date.now();
  server.stop();
  assert.equal(await server.done, 0);
  const took = Date.now() - stoppedAt;
  assert.ok(took >= 150 && took < 2000, `took ${took} ms`);
  assert.equal(await cut, "socket hang up", "the call was cut off, not answered");
});
