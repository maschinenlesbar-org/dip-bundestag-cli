// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome. Either both
// reject before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient, apiKeyProblem, normaliseApiKey } from "../src/client/client.js";
import { DipNetworkError, DipValidationError } from "../src/client/errors.js";
import { MAX_TIMEOUT_MS, type HttpRequest, type HttpResponse, type Transport } from "../src/client/http.js";
import { DEFAULT_USER_AGENT, MAX_REDIRECTS, MAX_RETRIES, RequestEngine } from "../src/client/engine.js";
import { KEY_SOURCE_URL, obtainKey } from "../src/client/obtain-key.js";
import { jsonResponse, parity, rawResponse, requestKey, type ParityResult } from "./helpers.js";

const client = (transport: Transport): DipClient => new DipClient({ apiKey: "k", transport });

/** Both sides rejected before any request: CLI with a usage error, library with DipValidationError. */
function assertBothReject(r: ParityResult, message?: RegExp): void {
  assert.equal(r.cli.code, 2, `CLI exit (stderr: ${r.cli.err})`);
  assert.equal(r.cli.requests.length, 0, "CLI sent a request");
  assert.equal(r.lib.ok, false, "library resolved");
  if (!r.lib.ok) {
    assert.ok(r.lib.error instanceof DipValidationError, `library threw ${String(r.lib.error)}`);
    if (message) assert.match((r.lib.error as Error).message, message);
  }
  assert.equal(r.lib.requests.length, 0, "library sent a request");
}

/** Both sides sent the identical request(s) and succeeded. */
function assertSameRequests(r: ParityResult): void {
  assert.equal(r.cli.code, 0, `CLI exit (stderr: ${r.cli.err})`);
  assert.equal(r.lib.ok, true, "library rejected");
  assert.ok(r.cli.requests.length > 0);
  assert.deepEqual(r.cli.requests.map(requestKey), r.lib.requests.map(requestKey));
}

// ---- Finding 2 (PAT-9): blank filter values, blank f.id, blank cursor ----------

const blankListCases: Array<{ argv: string[]; lib: (t: Transport) => Promise<unknown>; key: string }> = [
  { argv: ["vorgang", "list", "--filter", "f.titel="], lib: (t) => client(t).vorgaenge.list({ "f.titel": "" }), key: "f.titel" },
  { argv: ["drucksache-text", "list", "--filter", "f.titel=  "], lib: (t) => client(t).drucksacheText.list({ "f.titel": "  " }), key: "f.titel" },
  { argv: ["vorgangsposition", "list", "--id", ""], lib: (t) => client(t).vorgangspositionen.list({ "f.id": [""] }), key: "f.id" },
  { argv: ["plenarprotokoll-text", "list", "--id", "  "], lib: (t) => client(t).plenarprotokollText.list({ "f.id": ["  "] }), key: "f.id" },
  { argv: ["vorgang", "list", "--cursor", ""], lib: (t) => client(t).vorgaenge.list({ cursor: "" }), key: "cursor" },
  { argv: ["person", "list", "--cursor", " "], lib: (t) => client(t).personen.list({ cursor: " " }), key: "cursor" },
  { argv: ["aktivitaet", "list", "--filter", "f.person_id=  "], lib: (t) => client(t).aktivitaeten.list({ "f.person_id": "  " }), key: "f.person_id" },
  { argv: ["person", "list", "--filter", "f.person="], lib: (t) => client(t).personen.list({ "f.person": "" }), key: "f.person" },
];

for (const c of blankListCases) {
  test(`parity: ${c.argv.join(" ")} is rejected by both before any request`, async () => {
    const r = await parity({ argv: ["--api-key", "k", ...c.argv], lib: c.lib });
    assertBothReject(r, new RegExp(`^Invalid ${c.key.replace(".", "\\.")}: `));
  });
}

test("parity: a padded but non-blank filter value is sent as is by both", async () => {
  const r = await parity({
    argv: ["--api-key", "k", "vorgang", "list", "--filter", "f.titel= Klima "],
    lib: (t) => client(t).vorgaenge.list({ "f.titel": " Klima " }),
  });
  assertSameRequests(r);
});

test("library list() rejects an empty f.id array and a blank element among others", async () => {
  for (const params of [{ "f.id": [] }, { "f.id": ["1", " "] }]) {
    const calls: unknown[] = [];
    const c = new DipClient({ transport: async (req) => (calls.push(req), { status: 200, headers: {}, body: Buffer.from("{}") }) });
    await assert.rejects(c.vorgaenge.list(params), DipValidationError);
    assert.equal(calls.length, 0);
  }
});

test("library list() still omits undefined and null parameters", async () => {
  const r = await parity({
    argv: ["--api-key", "k", "vorgang", "list"],
    lib: (t) => client(t).vorgaenge.list({ cursor: undefined, "f.titel": null }),
  });
  assertSameRequests(r);
});

// ---- Finding 3 (PAT-10): a blank get id ----------------------------------------

const getResources: Array<[string, keyof DipClient]> = [
  ["vorgang", "vorgaenge"],
  ["vorgangsposition", "vorgangspositionen"],
  ["drucksache", "drucksachen"],
  ["drucksache-text", "drucksacheText"],
  ["plenarprotokoll", "plenarprotokolle"],
  ["plenarprotokoll-text", "plenarprotokollText"],
  ["aktivitaet", "aktivitaeten"],
  ["person", "personen"],
];

for (const [command, key] of getResources) {
  for (const id of ["", "   "]) {
    test(`parity: ${command} get ${JSON.stringify(id)} is rejected by both before any request`, async () => {
      const r = await parity({
        argv: ["--api-key", "k", "--compact", command, "get", id],
        lib: (t) => (client(t)[key] as DipClient["vorgaenge"]).get(id),
        responder: () => jsonResponse({ numFound: 2, documents: [] }),
      });
      assertBothReject(r, new RegExp(`^Invalid ${command} id: An id is required`));
      // The CLI prints the library's message, which names the right resource.
      assert.equal(r.cli.err, `Error: ${(r.lib as { error: Error }).error.message}`);
      assert.equal(r.cli.out, "");
    });
  }
}

// ---- Finding 8 (PAT-23, PAT-10): "." and ".." ids ---------------------------------

for (const [command, key] of getResources) {
  for (const id of [".", ".."]) {
    test(`parity: ${command} get ${id} is one DipValidationError on both sides`, async () => {
      const r = await parity({
        argv: ["--api-key", "k", "--compact", command, "get", id],
        lib: (t) => (client(t)[key] as DipClient["vorgaenge"]).get(id),
        responder: () => jsonResponse({ numFound: 2, documents: [] }),
      });
      assertBothReject(r, new RegExp(`^Invalid ${command} id: "\\." and "\\.\\." cannot be used as an id\\.$`));
      assert.equal(r.cli.err, `Error: ${(r.lib as { error: Error }).error.message}`);
      assert.equal(r.cli.out, "");
    });
  }
}

test("parity: a non-blank get id sends the same request on both sides", async () => {
  const r = await parity({
    argv: ["--api-key", "k", "person", "get", "7240"],
    lib: (t) => client(t).personen.get("7240"),
    responder: () => jsonResponse({ id: "7240" }),
  });
  assertSameRequests(r);
});

// ---- Finding 6 (PAT-8): timeout, retry and size-cap bounds ----------------------

const limitCases: Array<{ flag: string; value: string; option: string; bad: number }> = [
  { flag: "--max-response-bytes", value: "-1", option: "maxResponseBytes", bad: -1 },
  { flag: "--timeout", value: "-1", option: "timeoutMs", bad: -1 },
  { flag: "--timeout", value: String(MAX_TIMEOUT_MS + 1), option: "timeoutMs", bad: MAX_TIMEOUT_MS + 1 },
  { flag: "--max-retries", value: "11", option: "maxRetries", bad: 11 },
  { flag: "--max-retries", value: "Infinity", option: "maxRetries", bad: Infinity },
  { flag: "--timeout", value: "NaN", option: "timeoutMs", bad: NaN },
  { flag: "--max-retries", value: "1.5", option: "maxRetries", bad: 1.5 },
];

for (const c of limitCases) {
  test(`parity: ${c.flag} ${c.value} / ${c.option}: ${c.bad} is rejected by both before any request`, async () => {
    const r = await parity({
      argv: [c.flag, c.value, "vorgang", "list"],
      lib: (t) => new DipClient({ transport: t, [c.option]: c.bad }).vorgaenge.list(),
    });
    assertBothReject(r, new RegExp(`^Invalid ${c.option}: Expected `));
  });

  test(`parity: ${c.flag} ${c.value} / obtainKey ${c.option}: ${c.bad} is rejected by both before any request`, async () => {
    const r = await parity({
      argv: [c.flag, c.value, "obtain-key"],
      lib: (t) => obtainKey({ transport: t, [c.option]: c.bad }),
    });
    assertBothReject(r, new RegExp(`^Invalid ${c.option}: Expected `));
  });
}

test("parity: the bounds themselves (0 and the maximum) are accepted by both", async () => {
  const r = await parity({
    argv: ["--timeout", "0", "--max-retries", String(MAX_RETRIES), "--max-response-bytes", "0", "vorgang", "list"],
    lib: (t) => new DipClient({ transport: t, timeoutMs: 0, maxRetries: MAX_RETRIES, maxResponseBytes: 0 }).vorgaenge.list(),
  });
  assertSameRequests(r);
  assert.deepEqual(
    r.cli.requests.map((q) => [q.timeoutMs, q.maxResponseBytes]),
    r.lib.requests.map((q) => [q.timeoutMs, q.maxResponseBytes]),
  );
});

test("the engine rejects out-of-range retryDelayMs and maxRedirects too", () => {
  for (const options of [{ retryDelayMs: -1 }, { retryDelayMs: NaN }, { maxRedirects: -1 }, { maxRedirects: MAX_REDIRECTS + 1 }]) {
    assert.throws(() => new RequestEngine(options), DipValidationError, JSON.stringify(options));
  }
  new RequestEngine({ retryDelayMs: 0, maxRedirects: MAX_REDIRECTS });
});

// ---- Finding 5 (PAT-5, PAT-4): User-Agent values ---------------------------------

const badUserAgents: Array<[string, RegExp]> = [
  ["a\r\nX-Injected: 1", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u0000b", /^Invalid userAgent: Value contains control characters\.$/],
  ["a\u007fb", /^Invalid userAgent: Value contains control characters\.$/],
  ["bot\u20ac", /^Invalid userAgent: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/],
  ["\u0100", /^Invalid userAgent: Value contains characters outside Latin-1/],
  ["", /^Invalid userAgent: Expected a non-empty value\.$/],
  ["   ", /^Invalid userAgent: Expected a non-empty value\.$/],
];

for (const [ua, message] of badUserAgents) {
  test(`parity: --user-agent ${JSON.stringify(ua)} is rejected by DipClient before any request`, async () => {
    const r = await parity({
      argv: ["--user-agent", ua, "vorgang", "list"],
      lib: (t) => new DipClient({ transport: t, userAgent: ua }).vorgaenge.list(),
    });
    assertBothReject(r, message);
  });

  test(`parity: --user-agent ${JSON.stringify(ua)} is rejected by obtainKey before any request`, async () => {
    const r = await parity({
      argv: ["--user-agent", ua, "obtain-key"],
      lib: (t) => obtainKey({ transport: t, userAgent: ua }),
    });
    assertBothReject(r, message);
  });
}

for (const ua of [" ua ", "a\tb", "caf\u00e9"]) {
  test(`parity: --user-agent ${JSON.stringify(ua)} is sent unchanged by both`, async () => {
    const r = await parity({
      argv: ["--user-agent", ua, "vorgang", "list"],
      lib: (t) => new DipClient({ transport: t, userAgent: ua }).vorgaenge.list(),
    });
    assertSameRequests(r);
    assert.equal(r.lib.requests[0]?.headers?.["User-Agent"], ua);
  });
}

test("DipClient and obtainKey send the same default User-Agent", async () => {
  const r = await parity({
    argv: ["vorgang", "list"],
    lib: (t) => new DipClient({ transport: t }).vorgaenge.list(),
  });
  assert.equal(r.lib.requests[0]?.headers?.["User-Agent"], DEFAULT_USER_AGENT);
  const calls: Array<string | undefined> = [];
  await obtainKey({
    transport: async (req) => (calls.push(req.headers?.["User-Agent"]), { status: 500, headers: {}, body: Buffer.from("") }),
  }).catch(() => undefined);
  assert.ok(calls.length > 0 && calls.every((ua) => ua === DEFAULT_USER_AGENT));
});

test("the engine checks defaultHeaders names and values too", () => {
  for (const defaultHeaders of <Array<Record<string, string>>>[{ "X-A": "a\nb" }, { "X-A": "\u20ac" }, { "Bad Name": "x" }, { "": "x" }]) {
    assert.throws(() => new RequestEngine({ defaultHeaders }), DipValidationError, JSON.stringify(defaultHeaders));
  }
  new RequestEngine({ defaultHeaders: { "X-A": "caf\u00e9\tx" } });
});

// ---- Finding 4 (PAT-1, PAT-3): base URL whitespace and a trailing /api/v1 --------

const badBaseUrls: Array<[string, RegExp]> = [
  ["https://search.dip.bundestag.de/api/v1", /Leave out \/api\/v1: the base URL is the host, and the client adds \/api\/v1 itself \(try https:\/\/search\.dip\.bundestag\.de\)\./],
  ["https://search.dip.bundestag.de/api/v1/", /Leave out \/api\/v1/],
  ["https://h.example/mirror/api/v1", /\(try https:\/\/h\.example\/mirror\)\./],
  ["https://search.dip.bundestag.de ", /A base URL cannot have surrounding whitespace\./],
  [" https://search.dip.bundestag.de", /A base URL cannot have surrounding whitespace\./],
  ["https://h.example\n", /A base URL cannot have surrounding whitespace\./],
  ["\thttps://h.example", /A base URL cannot have surrounding whitespace\./],
  ["https://h.example/a\tb", /A base URL cannot contain whitespace or control characters\./],
  ["https://h.example/a b", /A base URL cannot contain whitespace or control characters\./],
];

for (const [baseUrl, message] of badBaseUrls) {
  test(`parity: --base-url ${JSON.stringify(baseUrl)} is rejected by DipClient before any request`, async () => {
    const r = await parity({
      argv: ["--base-url", baseUrl, "vorgang", "list"],
      lib: (t) => new DipClient({ apiKey: "k", baseUrl, transport: t }).vorgaenge.list(),
    });
    assertBothReject(r, new RegExp(`^Invalid baseUrl: .*${message.source}`));
    assert.match(r.cli.err, message);
  });

  test(`parity: --base-url ${JSON.stringify(baseUrl)} is rejected by obtainKey before any request`, async () => {
    for (const verify of [true, false]) {
      const r = await parity({
        argv: ["--base-url", baseUrl, "obtain-key", ...(verify ? [] : ["--no-verify"])],
        lib: (t) => obtainKey({ baseUrl, transport: t, verify }),
      });
      assertBothReject(r, /^Invalid baseUrl: /);
    }
  });
}

test("parity: a base URL with a trailing slash or a mirror path is used by both", async () => {
  for (const baseUrl of ["https://h.example/", "https://h.example/mirror"]) {
    const r = await parity({
      argv: ["--base-url", baseUrl, "vorgang", "list"],
      lib: (t) => new DipClient({ baseUrl, transport: t }).vorgaenge.list(),
    });
    assertSameRequests(r);
  }
});

// ---- Finding 10 (PAT-6): API key trimming and characters ----------------------

for (const key of ["k\n", "\rk", "\tk\r\n", " k "]) {
  test(`parity: --api-key ${JSON.stringify(key)}, DIP_API_KEY and the library all send "ApiKey k"`, async () => {
    const flag = await parity({
      argv: ["--api-key", key, "vorgang", "list"],
      lib: (t) => new DipClient({ apiKey: key, transport: t }).vorgaenge.list(),
    });
    assertSameRequests(flag);
    assert.equal(flag.cli.requests[0]?.headers?.["Authorization"], "ApiKey k");
    const env = await parity({
      argv: ["vorgang", "list"],
      env: { DIP_API_KEY: key },
      lib: (t) => new DipClient({ apiKey: key, transport: t }).vorgaenge.list(),
    });
    assertSameRequests(env);
  });
}

for (const [key, message] of [
  ["a\nb", /^Invalid apiKey: Value contains control characters\.$/],
  ["k€", /^Invalid apiKey: Value contains characters outside Latin-1 \(above U\+00FF\)\.$/],
] as const) {
  test(`parity: an API key ${JSON.stringify(key)} is rejected on every path before any request`, async () => {
    const flag = await parity({
      argv: ["--api-key", key, "vorgang", "list"],
      lib: (t) => new DipClient({ apiKey: key, transport: t }).vorgaenge.list(),
    });
    assertBothReject(flag, message);
    const env = await parity({
      argv: ["vorgang", "list"],
      env: { DIP_API_KEY: key },
      lib: (t) => new DipClient({ apiKey: key, transport: t }).vorgaenge.list(),
    });
    assertBothReject(env, message);
    assert.match(env.cli.err, /^Error: Invalid apiKey: /);
  });
}

test("normaliseApiKey trims, maps blank to undefined and rejects unsendable keys", () => {
  assert.equal(normaliseApiKey(undefined), undefined);
  assert.equal(normaliseApiKey("  "), undefined);
  assert.equal(normaliseApiKey("\tk\r\n"), "k");
  assert.throws(() => normaliseApiKey("a\nb"), DipValidationError);
  assert.equal(apiKeyProblem("a\u0000b"), "Value contains control characters.");
  assert.equal(apiKeyProblem(" k\n"), undefined);
});

// ---- Finding 7 (PAT-22): obtainKey goes through the engine's retry/redirect policy

const OK_KEY = "R2BZaee.DjdCyihKZMf8AOjtScubP2EVydegzjmBIQ";
const HELP = `{"data":{"content":["<p>Der API-Key lautet:<br />${OK_KEY}</p>"]}}`;

/**
 * Every URL answers a 503 (Retry-After: 0) to every odd-numbered request and its
 * real answer to the next one, so the CLI run and the library run that follows it
 * on the same responder both see one 503 per URL before the answer.
 */
function flakyKeyServer() {
  const count = new Map<string, number>();
  return (req: HttpRequest): HttpResponse => {
    const n = (count.get(req.url) ?? 0) + 1;
    count.set(req.url, n);
    if (n % 2 === 1) {
      return { status: 503, headers: { "retry-after": "0" }, body: Buffer.from("busy") };
    }
    if (req.url === KEY_SOURCE_URL) return rawResponse(HELP, "application/json");
    return req.headers?.["Authorization"] === `ApiKey ${OK_KEY}`
      ? jsonResponse({ numFound: 0, documents: [] })
      : rawResponse("denied", "text/plain", 401);
  };
}

test("parity: --max-retries 3 obtain-key retries a 503 like obtainKey({ maxRetries: 3 })", async () => {
  const r = await parity({
    argv: ["--max-retries", "3", "obtain-key"],
    lib: (t) => obtainKey({ transport: t, maxRetries: 3 }),
    responder: flakyKeyServer(),
  });
  assertSameRequests(r);
  assert.equal(r.cli.out, OK_KEY);
  assert.deepEqual(r.lib.ok && r.lib.value, { key: OK_KEY, sourceUrl: KEY_SOURCE_URL, verified: true });
  // One 503 and one retry on the source, then on the verification.
  assert.equal(r.lib.requests.length, 4);
});

test("parity: --max-retries 0 obtain-key does not retry, like obtainKey({ maxRetries: 0 })", async () => {
  const r = await parity({
    argv: ["--max-retries", "0", "obtain-key"],
    lib: (t) => obtainKey({ transport: t, maxRetries: 0 }),
    responder: () => ({ status: 503, headers: { "retry-after": "0" }, body: Buffer.from("busy") }),
  });
  assert.equal(r.cli.code, 1);
  // One request per source, no retry.
  assert.equal(r.cli.requests.length, 2);
  assert.equal(r.lib.ok, false);
  assert.deepEqual(r.cli.requests.map(requestKey), r.lib.requests.map(requestKey));
  assert.match(r.cli.err, /could not be read \(HTTP 503\)/);
});

test("obtainKey retries a 503 on the help document by default and yields the current key", async () => {
  const r = await parity({ argv: ["obtain-key", "--no-verify"], lib: (t) => obtainKey({ transport: t, verify: false }), responder: flakyKeyServer() });
  assert.equal(r.cli.out, OK_KEY);
  assert.deepEqual(r.lib.ok && r.lib.value, { key: OK_KEY, sourceUrl: KEY_SOURCE_URL, verified: false });
});

test("obtainKey follows a same-origin redirect on the verification request, like vorgang list", async () => {
  const responder = (req: HttpRequest): HttpResponse => {
    if (req.url === KEY_SOURCE_URL) return rawResponse(HELP, "application/json");
    if (req.url === "https://search.dip.bundestag.de/api/v1/vorgang") {
      return { status: 301, headers: { location: "/api/v1/vorgang/" }, body: Buffer.alloc(0) };
    }
    return req.headers?.["Authorization"] === `ApiKey ${OK_KEY}`
      ? jsonResponse({ numFound: 0, documents: [] })
      : rawResponse("denied", "text/plain", 401);
  };
  const r = await parity({ argv: ["obtain-key"], lib: (t) => obtainKey({ transport: t }), responder });
  assertSameRequests(r);
  assert.deepEqual(r.lib.ok && r.lib.value, { key: OK_KEY, sourceUrl: KEY_SOURCE_URL, verified: true });
});

// ---- Finding 9 (PAT-2): an invalid base URL is a DipValidationError -----------

const malformedBaseUrls: Array<[string, RegExp]> = [
  ["ftp://h.example", /Unsupported scheme "ftp:"\. Expected an http\(s\) URL\./],
  ["file:///etc/passwd", /Unsupported scheme "file:"\. Expected an http\(s\) URL\./],
  ["https://h.example/?q=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
  ["https://h.example/#f", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
  ["", /Expected an absolute http\(s\) URL\./],
  ["not a url", /Expected an absolute http\(s\) URL\./],
];

for (const [baseUrl, message] of malformedBaseUrls) {
  test(`parity: --base-url ${JSON.stringify(baseUrl)} is a DipValidationError in DipClient, not a network error`, async () => {
    const r = await parity({
      argv: ["--base-url", baseUrl, "vorgang", "list"],
      lib: (t) => new DipClient({ apiKey: "k", baseUrl, transport: t }).vorgaenge.list(),
    });
    assertBothReject(r, new RegExp(`^Invalid baseUrl: ${message.source}$`));
    assert.ok(!(r.lib.ok === false && r.lib.error instanceof DipNetworkError));
    assert.match(r.cli.err, message);
  });

  test(`parity: --base-url ${JSON.stringify(baseUrl)} is a DipValidationError in obtainKey`, async () => {
    for (const verify of [true, false]) {
      const r = await parity({
        argv: ["--base-url", baseUrl, "obtain-key", ...(verify ? [] : ["--no-verify"])],
        lib: (t) => obtainKey({ baseUrl, transport: t, verify }),
      });
      assertBothReject(r, new RegExp(`^Invalid baseUrl: ${message.source}$`));
      assert.match(r.cli.err, message);
    }
  });
}

// ---- Finding 1 (PAT-13): unknown filter keys -----------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unknownFilterCases: Array<{ argv: string[]; lib: (t: Transport) => Promise<unknown>; key: string; resource: string }> = [
  { argv: ["vorgang", "list", "--filter", "f.titl=Klima"], lib: (t) => client(t).vorgaenge.list({ "f.titl": "Klima" }), key: "f.titl", resource: "vorgang" },
  { argv: ["vorgang", "list", "--filter", "F.TITEL=Klima"], lib: (t) => client(t).vorgaenge.list({ "F.TITEL": "Klima" }), key: "F.TITEL", resource: "vorgang" },
  { argv: ["vorgang", "list", "--filter", "f.person=Merz"], lib: (t) => client(t).vorgaenge.list({ "f.person": "Merz" }), key: "f.person", resource: "vorgang" },
  { argv: ["drucksache", "list", "--filter", " f.titel=Klima"], lib: (t) => client(t).drucksachen.list({ " f.titel": "Klima" }), key: " f.titel", resource: "drucksache" },
  { argv: ["aktivitaet", "list", "--filter", "f.vorgang=1"], lib: (t) => client(t).aktivitaeten.list({ "f.vorgang": "1" }), key: "f.vorgang", resource: "aktivitaet" },
];

for (const c of unknownFilterCases) {
  test(`parity: unknown filter ${JSON.stringify(c.key)} on ${c.resource} is rejected by both before any request`, async () => {
    const r = await parity({ argv: ["--api-key", "k", ...c.argv], lib: c.lib });
    const reason = `Unknown filter "${escapeRe(c.key)}" for ${c.resource}\\. DIP ignores unknown filters and would return the whole unfiltered list\\. Filters for ${c.resource}: `;
    assertBothReject(r, new RegExp(`^Invalid filter: ${reason}`));
    assert.match(r.cli.err, new RegExp(reason));
  });
}

test("list(params, { allowUnknownFilters: true }) sends a filter that is not in LIST_FILTERS", async () => {
  const calls: HttpRequest[] = [];
  const t: Transport = async (req) => {
    calls.push(req);
    return jsonResponse({ numFound: 0, documents: [], cursor: "AoE" });
  };
  await client(t).vorgaenge.list({ "f.neuer_filter": "x", "f.titel": "Klima" }, { allowUnknownFilters: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/vorgang\?f\.neuer_filter=x&f\.titel=Klima$/);
  // The blank checks still apply with the opt-out.
  await assert.rejects(client(t).vorgaenge.list({ "f.neuer_filter": " " }, { allowUnknownFilters: true }), DipValidationError);
  assert.equal(calls.length, 1);
});

test("list() still accepts the resource's own filters and the cursor", async () => {
  const calls: HttpRequest[] = [];
  const t: Transport = async (req) => {
    calls.push(req);
    return jsonResponse({ numFound: 0, documents: [], cursor: "AoE" });
  };
  await client(t).personen.list({ "f.person": "Merz", cursor: "AoE" });
  await client(t).aktivitaeten.list({ "f.person": "Merz", "f.id": ["1", "2"] });
  assert.equal(calls.length, 2);
});

test("a cursor without any filter is refused by the CLI and by list(); allowUnfilteredCursor sends it", async () => {
  assertBothReject(
    await parity({ argv: ["vorgang", "list", "--cursor", "AoE"], lib: (t) => client(t).vorgaenge.list({ cursor: "AoE" }) }),
    /^Invalid cursor: A cursor without a filter pages through the whole unfiltered vorgang list/,
  );
  // Omitted values do not count as filters.
  await assert.rejects(client(async () => jsonResponse({ numFound: 0, documents: [] })).vorgaenge.list({ cursor: "AoE", "f.titel": undefined }), DipValidationError);
  const calls: HttpRequest[] = [];
  const t: Transport = async (req) => {
    calls.push(req);
    return jsonResponse({ numFound: 0, documents: [], cursor: "AoF" });
  };
  await client(t).vorgaenge.list({ cursor: "AoE" }, { allowUnfilteredCursor: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/vorgang\?cursor=AoE$/);
});
