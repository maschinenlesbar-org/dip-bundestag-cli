import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  escapeRawControlCharsInStrings,
  parseRetryAfter,
} from "../src/client/engine.js";
import { DipApiError, DipNetworkError, DipParseError, redactUrl } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("api/"), "https://example.test/api/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws DipParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), DipParseError);
});

test("getJson repairs a raw control character inside a string and parses it", async () => {
  // The DIP API sometimes serves a string value with a literal control char
  // (here a raw newline in `titel`), which standard JSON.parse rejects.
  const body = '{"titel":"a\nb","id":"7"}';
  const mt = makeMockTransport(() => rawResponse(body, "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { titel: "a\nb", id: "7" });
});

test("getJson still throws DipParseError when the repair cannot save it", async () => {
  // Structurally broken JSON (missing value) is not a control-char issue, so
  // the repaired text still fails to parse and the error is surfaced.
  const mt = makeMockTransport(() => rawResponse('{"a":}', "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), DipParseError);
});

test("escapeRawControlCharsInStrings escapes inside strings, not structural whitespace", () => {
  // Raw newline inside the string -> escaped; the newline between tokens stays.
  const repaired = escapeRawControlCharsInStrings('{\n  "t":"a\tb"\n}');
  assert.equal(repaired, '{\n  "t":"a\\u0009b"\n}');
  assert.deepEqual(JSON.parse(repaired), { t: "a\tb" });
});

test("escapeRawControlCharsInStrings does not mis-handle an escaped quote", () => {
  // The \" must not be read as the end of the string.
  const repaired = escapeRawControlCharsInStrings('{"t":"say \\"hi\\"\nthere"}');
  assert.deepEqual(JSON.parse(repaired), { t: 'say "hi"\nthere' });
});

test("a 503 is retried up to maxRetries then surfaces as DipApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DipApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

function redirectResponse(location: string, status = 302): HttpResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

test("a same-origin redirect is followed and keeps the Authorization header", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      // Same-origin absolute redirect.
      return redirectResponse(new URL("/moved", req.url).origin + "/moved");
    }
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: { Authorization: "ApiKey SECRET" },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
  // The follow-up request to the same origin still carries the credential.
  assert.equal(mt.calls[1]?.headers?.["Authorization"], "ApiKey SECRET");
  assert.equal(new URL(mt.calls[1]!.url).pathname, "/moved");
});

test("a relative redirect (same origin) keeps the Authorization header", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirectResponse("/elsewhere") : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: { Authorization: "ApiKey SECRET" },
  });
  await e.getJson("/x");
  assert.equal(mt.calls[1]?.headers?.["Authorization"], "ApiKey SECRET");
});

test("a cross-origin redirect drops credential headers", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1
      ? redirectResponse("https://evil.example/collect")
      : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: {
      Authorization: "ApiKey SECRET",
      "X-API-Key": "SECRET",
      Cookie: "session=abc",
    },
  });
  await e.getJson("/x");
  const followUp = mt.calls[1]!;
  assert.equal(new URL(followUp.url).origin, "https://evil.example");
  assert.equal(followUp.headers?.["Authorization"], undefined);
  assert.equal(followUp.headers?.["X-API-Key"], undefined);
  assert.equal(followUp.headers?.["Cookie"], undefined);
  // Non-credential headers still travel.
  assert.equal(followUp.headers?.["Accept"], "application/json");
});

test("a 3xx without a Location surfaces as a DipApiError", async () => {
  const mt = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DipApiError && err.status === 302,
  );
});

// Build control bytes via char codes so no raw control byte ever appears here.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test("the error detail is stripped of terminal control characters", async () => {
  // A hostile endpoint returns an OSC/ANSI escape in the JSON `detail` string.
  // JSON.parse decodes the backslash-u-001b escape into a real ESC byte, so
  // without the sanitizer it would reach the terminal via DipApiError.message.
  const hostile = `${ESC}]0;pwned${BEL}${ESC}[31mred`;
  const mt = makeMockTransport(() =>
    rawResponse(JSON.stringify({ detail: hostile }), "application/json", 400),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof DipApiError);
      assert.ok(!err.message.includes(ESC), "message must not contain ESC");
      assert.ok(!err.message.includes(BEL), "message must not contain BEL");
      // The printable text of the detail is preserved.
      assert.ok(err.message.includes("pwned"));
      assert.ok(err.message.includes("red"));
      return true;
    },
  );
});

// The default transport rejects a non-http(s) URL per hop, but a library consumer
// may inject its own transport, so the engine gates the base URL itself.
for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
  test(`the engine rejects the base URL ${baseUrl} before any request`, () => {
    const mt = makeMockTransport(() => jsonResponse({ ok: true }));
    assert.throws(() => new RequestEngine({ baseUrl, transport: mt.transport }), DipNetworkError);
    assert.equal(mt.calls.length, 0);
  });
}

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DipApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DipApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("the engine rejects a base URL with a query or fragment, redacting userinfo", () => {
  for (const baseUrl of ["https://api.test/?x=1", "https://u:secret@api.test/#f"]) {
    assert.throws(
      () => new RequestEngine({ baseUrl }),
      (err: unknown) =>
        err instanceof DipNetworkError &&
        /^Base URL must not contain a query or fragment: /.test(err.message) &&
        !err.message.includes("secret"),
    );
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("http://user:secret@h.test/a?b=1"), "http://***@h.test/a?b=1");
  assert.equal(redactUrl("https://h.test/x"), "https://h.test/x");
  assert.equal(redactUrl("not a url"), "not a url");
});
