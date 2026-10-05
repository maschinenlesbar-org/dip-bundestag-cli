// Conformance test P5 (fix plan 2026-10-06): the client's documented limits and retries hold
// for every transport, not only the built-in one — `timeoutMs`, `maxResponseBytes`,
// `Retry-After` and reset retries with the transports users actually write (fetch, a raw
// node:http wrapper, a test double). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { DipClient as Client } from "../src/client/client.js";
import { DipNetworkError as NetworkError } from "../src/client/errors.js";
/** One call that makes a single GET and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.vorgaenge.list();
/** A 2xx body the call accepts. */
const okBody = { numFound: 0, documents: [] };
// --------------------------------------------------------------------------------------

const okJson = (): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify(okBody)),
});

async function within<T>(ms: number, p: Promise<T>): Promise<T | "still pending"> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<"still pending">((resolve) => (timer = setTimeout(() => resolve("still pending"), ms)));
  try {
    return await Promise.race([p, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

test("P5: timeoutMs bounds a transport that never answers", async () => {
  let signal: AbortSignal | undefined;
  const transport = (req: HttpRequest) => {
    signal = req.signal;
    return new Promise<HttpResponse>(() => {});
  };
  const client = new Client({ transport, timeoutMs: 200, maxRetries: 0 });
  const outcome = await within(3000, call(client).then(() => "resolved", (e: unknown) => e));
  assert.ok(outcome instanceof NetworkError, `got ${String(outcome)}`);
  assert.equal(signal?.aborted, true, "the transport's signal is aborted at the deadline");
});

test("P5: timeoutMs bounds fetch against a server that never answers", async () => {
  const server = http.createServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      const r = await fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal });
      return { status: r.status, headers: r.headers as unknown as HttpResponse["headers"], body: new Uint8Array(await r.arrayBuffer()) as Buffer };
    };
    const client = new Client({ baseUrl: `http://127.0.0.1:${port}`, transport, timeoutMs: 300, maxRetries: 0 });
    const outcome = await within(3000, call(client).then(() => "resolved", (e: unknown) => e));
    assert.ok(outcome instanceof NetworkError, `got ${String(outcome)}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("P5: maxResponseBytes holds for a transport that read everything", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, 0x20);
  const transport = async (): Promise<HttpResponse> => ({ status: 200, headers: {}, body: big });
  const client = new Client({ transport, maxResponseBytes: 1024 * 1024, maxRetries: 0 });
  await assert.rejects(call(client), (e: unknown) => e instanceof NetworkError && /1048576/.test(e.message));
});

test("P5: every byte-array body type is read, from any realm", async () => {
  const bytes = Buffer.from(JSON.stringify(okBody));
  const bodies: unknown[] = [
    new Uint8Array(bytes),
    new Uint8Array(Buffer.concat([Buffer.from("xxxx"), bytes])).subarray(4),
    new DataView(new Uint8Array(bytes).buffer),
    new Uint8Array(bytes).buffer,
    vm.runInNewContext(`new Uint8Array(${JSON.stringify([...bytes])})`),
  ];
  for (const body of bodies) {
    const transport = async (): Promise<HttpResponse> => ({ status: 200, headers: {}, body: body as Buffer });
    await assert.doesNotReject(call(new Client({ transport })), `body ${Object.prototype.toString.call(body)}`);
  }
});

test("P5: Retry-After is read from a Headers object, a Map and any header case", async () => {
  for (const headers of [new Headers({ "Retry-After": "3" }), new Map([["retry-after", "3"]]), { "Retry-After": "3" }, { "RETRY-AFTER": "3" }]) {
    const sleeps: number[] = [];
    let n = 0;
    const transport = async (): Promise<HttpResponse> =>
      n++ === 0 ? { status: 503, headers: headers as unknown as HttpResponse["headers"], body: Buffer.from("{}") } : okJson();
    await call(new Client({ transport, maxRetries: 1, sleep: async (ms) => void sleeps.push(ms) }));
    assert.deepEqual(sleeps, [3000], `headers ${headers.constructor.name}`);
  }
});

test("P5: a reset is retried whatever shape the transport reports it in", async () => {
  const resets: Array<() => unknown> = [
    () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
    () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
  ];
  for (const reset of resets) {
    let n = 0;
    const transport = async (): Promise<HttpResponse> => {
      if (n++ === 0) throw reset();
      return okJson();
    };
    await assert.doesNotReject(call(new Client({ transport, maxRetries: 1, sleep: async () => {} })));
    assert.equal(n, 2);
  }
});

test("P5: whatever a transport throws or returns, the error is a NetworkError", async () => {
  const bad: Array<() => Promise<HttpResponse>> = [
    async () => { throw null; },
    async () => { throw "a string"; },
    () => { throw new Error("thrown synchronously"); },
    async () => ({}) as HttpResponse,
    async () => ({ status: Number.NaN, headers: {}, body: Buffer.alloc(0) }),
    async () => ({ headers: {}, body: Buffer.alloc(0) }) as unknown as HttpResponse,
  ];
  for (const transport of bad) {
    await assert.rejects(call(new Client({ transport, maxRetries: 0 })), NetworkError);
  }
});
