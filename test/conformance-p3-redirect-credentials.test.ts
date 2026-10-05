// Conformance test P3 (fix plan 2026-10-06): credentials go only to the origin they belong
// to. A redirect to another origin (another host, port or scheme — http→https included)
// drops the key and the base URL's userinfo; a same-origin redirect, absolute `Location`
// included, keeps them; a transport that follows a redirect itself is not trusted; a 401
// after an http→https redirect says so instead of blaming the key; and a key is only
// "verified" by an answer from the origin that received it. Written in dip-bundestag-cli;
// shared across the keyed and redirect-following *-cli repos, only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse, Transport } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "../src/client/client.js";
import { DipApiError as ApiError, DipError as BaseError, DipNetworkError as NetworkError } from "../src/client/errors.js";
import { obtainKey } from "../src/client/obtain-key.js";
/** A key the client sends, the header it goes in (lower case) and that header's value. */
const KEY = "SeKrEt1.abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_HEADER = "authorization";
const KEY_VALUE = `ApiKey ${KEY}`;
/** A client on `baseUrl` with the key (when `withKey`), no retries, and `transport` if given. */
const client = (baseUrl: string, withKey: boolean, transport?: Transport): Client =>
  new Client({ baseUrl, ...(withKey ? { apiKey: KEY } : {}), maxRetries: 0, ...(transport ? { transport } : {}) });
/** One call that makes a single GET, and the path that GET requests under the base URL. */
const call = (c: Client): Promise<unknown> => c.vorgaenge.list();
const CALL_PATH = "/api/v1/vorgang";
/** A 2xx body the call accepts. */
const okBody = { numFound: 0, documents: [] };
/** Whether the engine follows redirects (false: a 3xx must surface, and no hop is made). */
const FOLLOWS_REDIRECTS = true;
/** CLI argv for the call against `base` with the key. */
const cliArgv = (base: string): string[] => ["--base-url", base, "--api-key", KEY, "vorgang", "list"];
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = { writeFile: () => {}, outBinary: () => {} };
/**
 * Verify a key against `baseUrl`, reading the key from `sourceUrl` (a document the mock
 * serves as `keyDocument`); undefined when the repo has no verifying obtain-key.
 */
const verifyKey: ((baseUrl: string, sourceUrl: string) => Promise<{ verified: boolean }>) | undefined = (
  baseUrl,
  sourceUrl,
) => obtainKey({ baseUrl, sourceUrl, maxRetries: 0 });
const keyDocument = `Der derzeit gültige API-Key lautet: ${KEY}`;
// --------------------------------------------------------------------------------------

const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cookie"];
const BASIC = `Basic ${Buffer.from("alice:pw-s3cret").toString("base64")}`;

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
}

/** A local server that records every request and answers with `answer`. */
async function mock(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    answer(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const credentialsIn = (headers: http.IncomingHttpHeaders): string[] =>
  CREDENTIAL_HEADERS.filter((name) => headers[name] !== undefined);

test("P3: a redirect to another origin reaches it without the key or the userinfo", async () => {
  const b = await mock((_req, res) => sendJson(res, 200, okBody));
  const a = await mock((req, res) => {
    res.writeHead(302, { location: `${b.origin}${req.url ?? "/"}` });
    res.end();
  });
  try {
    for (const [base, withKey] of [
      [a.origin, true],
      [a.origin.replace("http://", "http://alice:pw-s3cret@"), false],
      [a.origin.replace("http://", "http://alice:pw-s3cret@"), true],
    ] as const) {
      const outcome = await call(client(base, withKey)).then(() => "ok", (e: unknown) => e);
      if (FOLLOWS_REDIRECTS) assert.equal(outcome, "ok", `${base} key:${withKey}: ${String(outcome)}`);
      else assert.ok(outcome instanceof BaseError, `${base}: a 3xx must surface`);
      const first = a.seen.at(-1);
      assert.ok(first !== undefined && credentialsIn(first.headers).length > 0, "A got the credentials");
    }
    assert.equal(b.seen.length, FOLLOWS_REDIRECTS ? 3 : 0);
    for (const hop of b.seen) assert.deepEqual(credentialsIn(hop.headers), [], `B got ${JSON.stringify(hop.headers)}`);
  } finally {
    await a.close();
    await b.close();
  }
});

test("P3: a same-origin redirect keeps the key and the userinfo, absolute Location included", async (t) => {
  if (!FOLLOWS_REDIRECTS) return t.skip("this engine follows no redirects");
  let origin = "";
  const a = await mock((req, res) => {
    if (req.url?.startsWith("/moved")) return sendJson(res, 200, okBody);
    res.writeHead(301, { location: `${origin}/moved${req.url ?? ""}` });
    res.end();
  });
  origin = a.origin;
  try {
    await call(client(a.origin, true));
    assert.equal(a.seen[1]?.headers[KEY_HEADER], KEY_VALUE, "the key follows a same-origin absolute redirect");
    await call(client(a.origin.replace("http://", "http://alice:pw-s3cret@"), false));
    assert.equal(a.seen[3]?.headers["authorization"], BASIC, "the userinfo follows a same-origin absolute redirect");
    assert.ok(a.seen.every((s) => !s.path.includes("alice")), "the userinfo is never in a request path");
  } finally {
    await a.close();
  }
});

test("P3: the transport is told not to follow redirects, and never sees userinfo", async () => {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(okBody)) };
  };
  await call(client("https://alice:pw-s3cret@mirror.example", true, transport));
  assert.equal(requests[0]?.redirect, "manual");
  assert.ok(!requests[0]?.url.includes("alice"), requests[0]?.url);
});

test("P3: a transport that followed a redirect to another origin itself is rejected", async () => {
  const at = (url: string) => async (req: HttpRequest): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
    url: url === "" ? req.url : url,
  });
  await assert.rejects(call(client("https://api.example", true, at("https://elsewhere.example/x"))), NetworkError);
  await assert.rejects(call(client("https://api.example", true, at("http://api.example/x"))), NetworkError);
  // The same origin (its own URL, or another path there) is fine.
  await assert.doesNotReject(call(client("https://api.example", true, at(""))));
  await assert.doesNotReject(call(client("https://api.example", true, at("https://api.example/other"))));
});

test("P3: a fetch transport with redirect 'manual' keeps the key on its origin", async (t) => {
  if (!FOLLOWS_REDIRECTS) return t.skip("this engine follows no redirects");
  const b = await mock((_req, res) => sendJson(res, 200, okBody));
  const a = await mock((req, res) => {
    res.writeHead(307, { location: `${b.origin}${req.url ?? "/"}` });
    res.end();
  });
  try {
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      const r = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.redirect !== undefined ? { redirect: req.redirect } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      return { status: r.status, headers: r.headers as unknown as HttpResponse["headers"], body: Buffer.from(await r.arrayBuffer()), url: r.url };
    };
    await call(client(a.origin, true, transport));
    assert.equal(a.seen[0]?.headers[KEY_HEADER], KEY_VALUE);
    assert.equal(b.seen.length, 1);
    assert.deepEqual(credentialsIn(b.seen[0]!.headers), []);
  } finally {
    await a.close();
    await b.close();
  }
});

test("P3: a 401 after an http→https redirect names the redirect, not the key", async (t) => {
  if (!FOLLOWS_REDIRECTS) return t.skip("this engine follows no redirects");
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (req.url.startsWith("http:")) {
      return { status: 301, headers: { location: req.url.replace("http:", "https:") }, body: Buffer.alloc(0) };
    }
    return { status: 401, headers: { "content-type": "application/json" }, body: Buffer.from('{"message":"An API key is required"}') };
  };
  await assert.rejects(call(client("http://api.example", true, transport)), (e: unknown) => {
    assert.ok(e instanceof ApiError && e.status === 401, String(e));
    assert.match(e.message, /https/);
    assert.match(e.message, /use an https base URL/);
    return true;
  });
  assert.equal(requests[0]?.headers?.["Authorization"] ?? requests[0]?.headers?.[KEY_HEADER], KEY_VALUE, "the key went to the http origin");
  assert.deepEqual(credentialsIn(Object.fromEntries(Object.entries(requests[1]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))), []);

  // The CLI prints that hint, not "check your API key".
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env: {},
    createClient: (opts) => new Client({ ...opts, transport }),
    transport,
  };
  const code = await run(cliArgv("http://api.example"), deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /use an https base URL/);
  assert.doesNotMatch(err.join("\n"), /Check your API key/i);
});

test("P3: a key counts as verified only when the origin that received it answered", async (t) => {
  if (verifyKey === undefined) return t.skip("this repo has no verifying obtain-key");
  const b = await mock((_req, res) => sendJson(res, 200, okBody));
  const a = await mock((req, res) => {
    if (req.url === "/doc") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(keyDocument);
    }
    if (req.url?.startsWith("/direct")) return sendJson(res, 200, okBody);
    res.writeHead(302, { location: `${b.origin}${CALL_PATH}` });
    res.end();
  });
  try {
    await assert.rejects(verifyKey(`${a.origin}/redirecting`, `${a.origin}/doc`), BaseError);
    assert.ok(b.seen.every((s) => credentialsIn(s.headers).length === 0), "B never saw the key");
    const direct = await verifyKey(`${a.origin}/direct`, `${a.origin}/doc`);
    assert.equal(direct.verified, true);
  } finally {
    await a.close();
    await b.close();
  }
});
