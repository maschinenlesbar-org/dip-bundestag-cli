// Conformance test P28 (security audit 2026-10-27, classes A, C, D and D2): a hostile answer
// ends in one clean error, in time and within memory, and no error quotes a credential of the
// base URL, however the server spells it.
// - A number literal with a long run of zeros (`1.<zeros>1e300`) is checked in linear time: the
//   trailing-zero regex `/0+$/` was quadratic and held the CLI for seconds past --timeout.
// - Server text bound for a message is cut before it is cleaned, and cleaned in linear time: an
//   unterminated run of 8-bit control-string introducers (U+009D) made the escape-sequence regex
//   quadratic, and one `+=` per character over a 16 MB error detail exhausted a small heap.
// - Many lone surrogate escapes in a 2xx answer are repaired within a small heap: one `+=` per
//   repair made a rope node each.
// - The base URL's credentials are scrubbed from decoded server text too: a JSON-escaped echo
//   (`\"`, `ä`) passed the scrub of the body as sent, into `.message`, `.detail` and the
//   decoded `.body`; and from a redirect's Location, in its path and query.
// The memory cases run the built bin in a child process with --max-old-space-size. Shared
// across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
import { DipClient as Client } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
/**
 * CLI argv (after the global options) for one GET whose answer carries a free-form value, and the
 * same call in the library. A test key is passed, so the child never reads the user's credentials
 * file. (The API key is scrubbed like the base URL's credentials; the client's engine.test.ts
 * checks it for the escaped echo, the quoted member name and the Location.)
 */
const call = ["--api-key", "p28-test-key", "vorgang", "get", "1"];
const lib = (client: Client): Promise<unknown> => client.vorgaenge.get("1");
/** The raw 2xx body with `json` (a JSON value, written as is) as that value. */
const bodyWith = (json: string): string => `{"id":"1","x":${json}}`;
/** An error body (any status) whose message the client quotes, with `json` (a JSON string, written as is) as that message. */
const errorBodyWith = (json: string): string => `{"message":${json}}`;
/**
 * A 2xx body the client refuses with a message that quotes a value of it, given that value as a
 * JSON string written as is: a document without an `id`, whose member names the shape error
 * quotes (`got an object with "…"`).
 */
const quotedBody: ((json: string) => string) | undefined = (json) => `{${json}:1}`;
/** The exit code of an API error (a non-2xx answer) and of a parse error in this repo (most use 1). */
const API_EXIT = 1;
/**
 * How the error reads when every request is answered with a 302 to the Location under test: dip
 * follows redirects, so it ends at its redirect limit (5) and names the last target.
 */
const REDIRECT_ERROR = /^HTTP 302 .*\(stopped after 5 redirects\)$/;
/** The log program, as in `ERROR [<bin>.api]`. */
const PROGRAM = "dip";
// --------------------------------------------------------------------------------------

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

/** Milliseconds `work` takes. */
async function elapsed(work: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

const response = (status: number, body: string, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: Buffer.from(body, "utf8"),
});

/** The error the call raises against `transport`, with the base URL `baseUrl`. */
async function failure(transport: (req: HttpRequest) => Promise<HttpResponse>, baseUrl?: string): Promise<unknown> {
  const client = new Client({ transport, maxRetries: 0, ...(baseUrl === undefined ? {} : { baseUrl }) });
  try {
    await lib(client);
  } catch (err) {
    return err;
  }
  return assert.fail("the call should have failed");
}

test("P28: a number with a long run of zeros is refused in linear time", async () => {
  // 1.<100 000 zeros>1e300 took about 15 s with the regex; the linear check takes milliseconds.
  const body = bodyWith(`1.${"0".repeat(100_000)}1e300`);
  let err: unknown;
  const ms = await elapsed(async () => (err = await failure(async () => response(200, body))));
  assert.ok(ms < 1000, `${Math.round(ms)} ms`);
  assert.ok(err instanceof Error && /cannot be represented exactly/.test(err.message), String(err));
  assert.ok((err as Error).message.length < 1000, "the message quotes the literal cut");
});

test("P28: an error answer of unterminated control-string introducers is cleaned in linear time", async () => {
  // 100 000 × U+009D took about 16 s with the old escape-sequence regex.
  for (const opener of ["\\u009d", "\\u0090", "\\u0098", "\\u009e", "\\u009f", "\\u001b]"]) {
    const body = errorBodyWith(`"${opener.repeat(100_000)} tail"`);
    let err: unknown;
    const ms = await elapsed(async () => (err = await failure(async () => response(500, body))));
    assert.ok(ms < 1000, `${opener}: ${Math.round(ms)} ms`);
    assert.ok(err instanceof Error && /^HTTP 500 /.test(err.message), String(err));
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(err.message), `${opener}: a control character in the message`);
  }
});

/** Serve `status` and `body` to one run of the bin with a heap of `heapMb`, then stop. */
async function runWithAnswer(status: number, body: Buffer, heapMb: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, BIN, "--base-url", base, "--max-retries", "0", ...call],
        { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** No crash: no V8 out-of-memory report, no abort, no stack. */
function noCrash(run: { code: number | null; signal: NodeJS.Signals | null; stderr: string }, label: string): void {
  assert.notEqual(run.signal, "SIGABRT", `${label}: aborted`);
  assert.ok(run.code !== null && run.code !== 134, `${label}: exit ${run.code} ${run.signal}`);
  assert.doesNotMatch(run.stderr, /FATAL ERROR|heap out of memory|Allocation failed|\n\s+at /, `${label}: ${run.stderr.slice(0, 500)}`);
}

test("P28: a 16 MB error message ends in one ERROR record within a small heap", STARTS_A_PROCESS, async () => {
  const run = await runWithAnswer(500, Buffer.from(errorBodyWith(`"${"x ".repeat(8_000_000)}"`)), 128);
  noCrash(run, "16 MB message");
  assert.equal(run.code, API_EXIT, run.stderr.slice(0, 500));
  assert.equal(run.stdout, "");
  const records = run.stderr.trim().split("\n");
  assert.equal(records.length, 1, run.stderr.slice(0, 500));
  assert.match(records[0] ?? "", new RegExp(`ERROR \\[${PROGRAM}\\.api\\] HTTP 500 `));
  assert.ok((records[0] ?? "").length < 5000, "the record is cut");
});

test("P28: an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, async () => {
  // 6 million repairs (36 MB): one `+=` each exhausted a 128 MB heap; batched, 96 MB suffice.
  const n = 6_000_000;
  const run = await runWithAnswer(200, Buffer.from(bodyWith(`"${"\\ud800".repeat(n)}"`)), 128);
  noCrash(run, "lone surrogates");
  assert.equal(run.code, 0, run.stderr.slice(0, 500));
  assert.match(run.stderr, new RegExp(`WARN  \\[${PROGRAM}\\.api\\] GET \\S+: ${n} characters of the answer were not valid text`));
});

// A password with characters a JSON writer escapes (a quote) or may write as \u00XX (an umlaut),
// and one a URL's query percent-encodes but encodeURIComponent doesn't (an apostrophe).
const PW = "pä\"s's-W0rd";
const BASE = `https://alice:${encodeURIComponent(PW)}@mirror.example`;
const BASIC = Buffer.from(`alice:${PW}`, "utf8").toString("base64");
/** The forms of the credential an error must not carry: decoded, and as a quoted value spells them (`\"`). */
const SECRETS = [PW, `alice:${PW}`, BASIC].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);

/** Everything a library user may log of an error: inspect, message, detail, location, and the decoded body. */
function everything(err: unknown): string {
  let text = inspect(err, { depth: 10, showHidden: true });
  const e = err as { message?: unknown; detail?: unknown; location?: unknown; body?: unknown };
  text += [e.message, e.detail, e.location, e.body].map(String).join("\n");
  let decoded: unknown;
  try {
    decoded = typeof e.body === "string" ? JSON.parse(e.body) : undefined;
  } catch {
    // not JSON: the body as sent is all a caller reads
  }
  // The decoded strings and names, as a caller who parses the body sees them.
  const walk = (v: unknown): void => {
    if (typeof v === "string") text += `\n${v}`;
    else if (v !== null && typeof v === "object") {
      for (const [k, w] of Object.entries(v)) {
        text += `\n${k}`;
        walk(w);
      }
    }
  };
  walk(decoded);
  return text;
}

/** `text` with every run of percent escapes decoded where it is valid UTF-8. */
const percentDecoded = (text: string): string =>
  text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

/** `text` as a JSON writer that escapes every non-ASCII character writes it (Python's json.dumps, PHP's json_encode). */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** `text` with every character written as a \uXXXX escape: no spelling of it as sent matches. */
const escapedJson = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

test("P28: a credential echoed with JSON escapes is scrubbed from the message, the detail and the decoded body", async () => {
  const echoes: Array<[string, string]> = [
    ["the password, ASCII-only JSON", asciiJson(`wrong password ${PW}`)],
    ["the user:password, minimal JSON", JSON.stringify(`bad login alice:${PW}`)],
    ["the password, every character escaped", escapedJson(PW)],
    ["the request URL as the server decoded it", JSON.stringify(`no access to https://alice:${PW}@mirror.example/x`)],
  ];
  for (const status of [401, 500]) {
    for (const [label, json] of echoes) {
      const err = await failure(async () => response(status, errorBodyWith(json)), BASE);
      assert.ok(err instanceof Error && err.message.startsWith(`HTTP ${status} `), `${label}: ${String(err)}`);
      const seen = everything(err);
      for (const secret of SECRETS) assert.ok(!seen.includes(secret), `${status} ${label}: ${seen.slice(0, 2000)}`);
    }
  }
});

test("P28: a credential in a value the client quotes from a 2xx answer is scrubbed", { skip: quotedBody === undefined }, async () => {
  for (const json of [asciiJson(PW), JSON.stringify(`alice:${PW}`), escapedJson(PW)]) {
    const err = await failure(async () => response(200, (quotedBody as (json: string) => string)(json)), BASE);
    assert.ok(err instanceof Error, String(err));
    const seen = everything(err);
    for (const secret of SECRETS) assert.ok(!seen.includes(secret), `${json}: ${seen.slice(0, 2000)}`);
  }
});

test("P28: a credential in a redirect's Location is scrubbed, in its path and its query", async () => {
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(PW)}`,
    `https://elsewhere.example/login?pw=${PW}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${PW}`)}/x`,
    `https://elsewhere.example/auth?basic=${BASIC}`,
    `/relative/${PW}`,
  ];
  for (const location of locations) {
    const err = await failure(async () => response(302, "", { location }), BASE);
    assert.ok(err instanceof Error && REDIRECT_ERROR.test(err.message), String(err));
    const seen = percentDecoded(everything(err));
    for (const secret of SECRETS) assert.ok(!seen.includes(secret), `${location}: ${seen.slice(0, 2000)}`);
  }
});
