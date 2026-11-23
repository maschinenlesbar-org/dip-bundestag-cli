// Conformance test M6 (MCP kit, rollout plan 2026-11-19): the limiter around the upstream
// transport: requests in flight, the per-minute window, a 429's pause (seconds or an HTTP date),
// the bounded queue (refused with the client's network error), and an abort that leaves the
// queue. A pause lasts at most 30 s, whatever the Retry-After; a clock set back stretches no hold
// and no timer overflows. Shared whole across the repos with an MCP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkError, type HttpRequest, type HttpResponse } from "../src/mcp/api.js";
import { callSignal, limitTransport } from "../src/mcp/limiter.js";

const ok = (status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: Buffer.from("{}") });
const request = (signal?: AbortSignal): HttpRequest => ({ method: "GET", url: "https://x/", headers: {}, ...(signal === undefined ? {} : { signal }) }) as HttpRequest;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A transport whose answers the test releases one by one. */
function gated() {
  const started: (() => void)[] = [];
  const transport = () => new Promise<HttpResponse>((resolve) => started.push(() => resolve(ok())));
  return { started, transport };
}

test("at most inFlight requests at once; the next starts when one ends", async () => {
  const { started, transport } = gated();
  const limited = limitTransport(transport, { inFlight: 2 });
  const calls = [limited(request()), limited(request()), limited(request())];
  await tick();
  assert.equal(started.length, 2);
  started[0]?.();
  await calls[0];
  await tick();
  assert.equal(started.length, 3);
  started[1]?.();
  started[2]?.();
  await Promise.all(calls);
});

test("at most perMinute starts in 60 s: the next waits", async () => {
  let t = 1_000_000;
  const limited = limitTransport(async () => ok(), { perMinute: 2, now: () => t });
  await limited(request());
  await limited(request());
  const controller = new AbortController();
  let third = false;
  const pending = limited(request(controller.signal)).then(() => (third = true), () => "left");
  await tick();
  assert.equal(third, false, "the third waits for the window");
  t += 61_000;
  controller.abort();
  assert.equal(await pending, "left");
});

test("a 429 pauses every start for its Retry-After", async () => {
  let t = 0;
  let first = true;
  const limited = limitTransport(async () => (first ? ((first = false), ok(429, { "retry-after": "30" })) : ok()), { now: () => t });
  assert.equal((await limited(request())).status, 429);
  const controller = new AbortController();
  let started = false;
  const pending = limited(request(controller.signal)).then(() => (started = true), () => "left");
  await tick();
  assert.equal(started, false, "paused");
  controller.abort();
  assert.equal(await pending, "left");
});

test("a 429's Retry-After in seconds or as an HTTP date pauses until then; an unreadable one pauses 5 s", async () => {
  for (const [header, pausedFor] of [["30", 30_000], [new Date(30_000).toUTCString(), 30_000], ["soon", 5_000]] as const) {
    let t = 0;
    let first = true;
    const limited = limitTransport(async () => (first ? ((first = false), ok(429, { "retry-after": header })) : ok()), { now: () => t });
    await limited(request());
    t = pausedFor - 1;
    let started = false;
    const controller = new AbortController();
    const pending = limited(request(controller.signal)).then(() => (started = true), () => "left");
    await tick();
    assert.equal(started, false, `still paused just before ${pausedFor} ms (${header})`);
    controller.abort();
    assert.equal(await pending, "left");
    t = pausedFor;
    assert.equal((await limited(request())).status, 200, `starts again at ${pausedFor} ms`);
  }
});

test("a 429's pause lasts at most 30 s, however long its Retry-After", async () => {
  for (const header of ["86400", "Fri, 01 Jan 2100 00:00:00 GMT"]) {
    let t = 0;
    let first = true;
    const limited = limitTransport(async () => (first ? ((first = false), ok(429, { "retry-after": header })) : ok()), { now: () => t });
    await limited(request());
    t = 29_999;
    let started = false;
    const controller = new AbortController();
    const pending = limited(request(controller.signal)).then(() => (started = true), () => "left");
    await tick();
    assert.equal(started, false, `still paused just before 30 s (${header})`);
    controller.abort();
    assert.equal(await pending, "left");
    t = 30_000;
    const after = new AbortController();
    let again = false;
    const next = limited(request(after.signal)).then(() => (again = true), () => "left");
    await tick();
    assert.equal(again, true, `starts again at 30 s (${header})`);
    after.abort();
    await next;
  }
});

test("a clock set back (a wall-clock correction) stretches no hold past its longest, and no timer overflows", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.name);
  };
  process.on("warning", onWarning);
  try {
    const year = 365 * 86_400_000;
    let t = 2 * year;
    let first = true;
    const limited = limitTransport(async () => (first ? ((first = false), ok(429, { "retry-after": "30" })) : ok()), { perMinute: 1, now: () => t });
    await limited(request());
    t -= year;
    const controller = new AbortController();
    let started = false;
    const pending = limited(request(controller.signal)).then(() => (started = true), () => "left");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, false, "held by the pause and the window");
    assert.deepEqual(warnings.filter((name) => name === "TimeoutOverflowWarning"), [], "no timer overflowed");
    t += 60_000;
    const later = new AbortController();
    const next = limited(request(later.signal)).catch(() => "left");
    await tick();
    assert.equal(started, true, "starts once the longest hold (60 s, the window) has passed");
    later.abort();
    controller.abort();
    await Promise.all([pending, next]);
  } finally {
    process.off("warning", onWarning);
  }
});

test("a full queue refuses at once; an aborted waiter leaves the queue", async () => {
  const { started, transport } = gated();
  const limited = limitTransport(transport, { inFlight: 1, queue: 1 });
  const first = limited(request());
  const controller = new AbortController();
  const waiting = limited(request(controller.signal));
  await assert.rejects(limited(request()), (err: unknown) => err instanceof NetworkError && /busy/.test(err.message));
  controller.abort(new NetworkError("aborted by the test"));
  await assert.rejects(waiting, /aborted by the test/);
  const next = limited(request());
  started[0]?.();
  await first;
  await tick();
  assert.equal(started.length, 2, "the aborted waiter never started");
  started[1]?.();
  await next;
});

test("inside a call, a request carries the call's signal; after its abort none is sent", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const limited = limitTransport(async (r) => {
    seen.push(r.signal);
    return ok();
  });
  const controller = new AbortController();
  await callSignal.run(controller.signal, () => limited(request()));
  assert.equal(seen.length, 1);
  controller.abort();
  assert.equal(seen[0]?.aborted, true);
  await assert.rejects(callSignal.run(controller.signal, () => limited(request())), (err: unknown) => err instanceof NetworkError && /aborted/.test(err.message));
  assert.equal(seen.length, 1);
});
