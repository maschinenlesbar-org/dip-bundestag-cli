// `obtain-key` for DIP. The Bundestag rotates its published key, so the command
// reads it at run time and verifies it before printing. These tests pin the
// rules that matter: read the help document DIP itself serves, fall back to the
// community mirror, and never hand back a key known to be dead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DipClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import {
  API_KEY_ENV_VAR,
  KEY_SOURCE_URL,
  KEY_SOURCE_FALLBACK_URL,
  extractKeyCandidates,
  obtainKey,
} from "../src/client/obtain-key.js";
import { DipError, DipNetworkError } from "../src/client/errors.js";
import { makeMockTransport, rawResponse, jsonResponse } from "./helpers.js";

const KEY = "R2BZaee.DjdCyihKZMf8AOjtScubP2EVydegzjmBIQ";
const STALE_KEY = "OSOegLs.PR2lwJ1dwCeje9vTj7FPOt3hvpYKtwKkhw";

/** The shape DIP's content service actually serves for the help page. */
const HELP_DOC = JSON.stringify({
  id: "help-api",
  data: {
    label: "API",
    content: [
      "<p>Zur Nutzung ist ein API-Key notwendig. Der zunächst bis Ende Mai 2027 " +
        `gültige API-Key lautet:<br />${KEY}</p>`,
    ],
  },
});
/** The fallback mirror states it in an Authorization header example. */
const README_DOC = `Send it as \`Authorization: ApiKey ${STALE_KEY}\` on every request.`;

/**
 * Serve each source its real document, then answer verification per key:
 * anything in `accept` authenticates, everything else is rejected with 401.
 */
function responder(accept: readonly string[], verifyStatus = 401) {
  return (req: HttpRequest): HttpResponse => {
    if (req.url === KEY_SOURCE_URL) return rawResponse(HELP_DOC, "application/json");
    if (req.url === KEY_SOURCE_FALLBACK_URL) return rawResponse(README_DOC, "text/plain");
    const sent = req.headers?.["Authorization"];
    return accept.some((k) => sent === `ApiKey ${k}`)
      ? jsonResponse({ numFound: 0, documents: [] })
      : rawResponse("denied", "text/plain", verifyStatus);
  };
}

function makeCli(r: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(r);
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: () => {},
      outBinary: () => {},
    },
    createClient: (opts) => new DipClient({ ...opts, transport: mt.transport }),
    env: {},
    transport: mt.transport,
  };
  return { deps, out, err, mt };
}

test("extractKeyCandidates reads the key out of DIP's own help document", () => {
  assert.deepEqual(extractKeyCandidates(HELP_DOC), [KEY]);
});

test("extractKeyCandidates reads the Authorization-header form too", () => {
  assert.deepEqual(extractKeyCandidates(README_DOC), [STALE_KEY]);
});

test("extractKeyCandidates prefers the labelled key over other token-shaped text", () => {
  const noisy = `<p>build.a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6</p><p>API-Key lautet:<br />${KEY}</p>`;
  assert.equal(extractKeyCandidates(noisy)[0], KEY);
});

test("obtainKey reads DIP's help document first and verifies the key", async () => {
  const mt = makeMockTransport(responder([KEY]));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_URL);
  assert.equal(result.verified, true);
  // Two requests: read the help document, then prove the key works.
  assert.equal(mt.calls.length, 2);
  assert.equal(mt.calls[0]?.url, KEY_SOURCE_URL);
  assert.equal(mt.calls[1]?.headers?.["Authorization"], `ApiKey ${KEY}`);
});

test("obtainKey falls back to the mirror when the help document is unreachable", async () => {
  const base = responder([STALE_KEY]);
  const mt = makeMockTransport((req) =>
    req.url === KEY_SOURCE_URL ? rawResponse("gone", "text/plain", 503) : base(req),
  );
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, STALE_KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_FALLBACK_URL);
  assert.equal(result.verified, true);
});

test("obtainKey skips a source whose key the API rejects and tries the next", async () => {
  // The regression this command exists for, inverted: the help doc is stale and
  // only the mirror's key still authenticates.
  const mt = makeMockTransport(responder([STALE_KEY]));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, STALE_KEY);
  assert.equal(result.sourceUrl, KEY_SOURCE_FALLBACK_URL);
});

test("obtainKey refuses when no published key is accepted", async () => {
  const mt = makeMockTransport(responder([]));
  await assert.rejects(
    () => obtainKey({ transport: mt.transport }),
    (err: unknown) => {
      assert.ok(err instanceof DipError);
      assert.match(err.message, /no longer accepted/);
      assert.match(err.message, /dip\.bundestag\.de/);
      return true;
    },
  );
});

test("obtainKey reports a non-auth failure as the API being unwell, not a bad key", async () => {
  const mt = makeMockTransport(responder([], 500));
  await assert.rejects(
    () => obtainKey({ transport: mt.transport }),
    (err: unknown) => {
      assert.ok(err instanceof DipError);
      assert.match(err.message, /Could not verify the key/);
      return true;
    },
  );
});

test("obtainKey with verify:false skips the check and flags it", async () => {
  const mt = makeMockTransport(responder([]));
  const result = await obtainKey({ transport: mt.transport, verify: false });
  assert.equal(result.key, KEY);
  assert.equal(result.verified, false);
  assert.equal(mt.calls.length, 1);
});

test("obtainKey honours an explicit sourceUrl instead of the default chain", async () => {
  const mt = makeMockTransport(responder([STALE_KEY]));
  const result = await obtainKey({
    transport: mt.transport,
    sourceUrl: KEY_SOURCE_FALLBACK_URL,
  });
  assert.equal(result.sourceUrl, KEY_SOURCE_FALLBACK_URL);
  assert.equal(mt.calls[0]?.url, KEY_SOURCE_FALLBACK_URL);
});

test("obtainKey throws when no source states a key", async () => {
  const mt = makeMockTransport(() => rawResponse("# no key here", "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), DipError);
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(responder([KEY]));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [KEY]);
  assert.match(cli.err.join("\n"), /verified it against the live API/);
  assert.match(cli.err.join("\n"), /content\.dip\.bundestag\.de/);
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(responder([KEY]));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='${KEY}'`]);
});

test("a rejected key exits non-zero and prints nothing on stdout", async () => {
  const cli = makeCli(responder([]));
  const code = await run(["obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("--no-verify prints the candidate but warns loudly on stderr", async () => {
  const cli = makeCli(responder([]));
  const code = await run(["obtain-key", "--no-verify"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [KEY]);
  assert.match(cli.err.join("\n"), /WITHOUT verifying/);
});

// The verification request carries the candidate key, so a non-http(s) base URL
// is refused before anything is sent, whatever transport is injected.
test("obtainKey rejects a non-http(s) base URL before any request", async () => {
  const mt = makeMockTransport(responder([KEY]));
  await assert.rejects(
    () => obtainKey({ transport: mt.transport, baseUrl: "file:///etc/passwd" }),
    DipNetworkError,
  );
  assert.equal(mt.calls.length, 0);
});

test("obtain-key rejects --base-url file:///etc/passwd before any request", async () => {
  const cli = makeCli(responder([KEY]));
  const code = await run(["--base-url", "file:///etc/passwd", "obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join(""), /--base-url/);
});

test("obtainKey applies the client's default timeout and size cap to every request", async () => {
  const mt = makeMockTransport(responder([KEY]));
  await obtainKey({ transport: mt.transport });
  assert.equal(mt.calls.length, 2);
  for (const call of mt.calls) {
    assert.equal(call.timeoutMs, 30_000);
    assert.equal(call.maxResponseBytes, 100 * 1024 * 1024);
  }
});

test("obtainKey passes explicit limits on, and 0 disables them", async () => {
  const mt = makeMockTransport(responder([KEY]));
  await obtainKey({ transport: mt.transport, timeoutMs: 5000, maxResponseBytes: 4096 });
  assert.ok(mt.calls.every((c) => c.timeoutMs === 5000 && c.maxResponseBytes === 4096));
  const unlimited = makeMockTransport(responder([KEY]));
  await obtainKey({ transport: unlimited.transport, timeoutMs: 0, maxResponseBytes: 0 });
  assert.ok(unlimited.calls.every((c) => c.timeoutMs === undefined && c.maxResponseBytes === undefined));
});

test("obtain-key hands --timeout and --max-response-bytes to every request", async () => {
  const cli = makeCli(responder([KEY]));
  const code = await run(["--timeout", "1500", "--max-response-bytes", "2048", "obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.ok(cli.mt.calls.every((c) => c.timeoutMs === 1500 && c.maxResponseBytes === 2048));
});
