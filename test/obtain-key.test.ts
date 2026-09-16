// `obtain-key` for DIP. Unlike the sibling CLIs, DIP's published key moves and
// the machine-readable source lags, so the command verifies before it prints.
// These tests pin the rule that matters: never hand back a key known to be dead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DipClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { API_KEY_ENV_VAR, KEY_SOURCE_URL, obtainKey } from "../src/client/obtain-key.js";
import { DipError } from "../src/client/errors.js";
import { makeMockTransport, rawResponse, jsonResponse } from "./helpers.js";

const KEY = "OSOegLs.PR2lwJ1dwCeje9vTj7FPOt3hvpYKtwKkhw";
const SOURCE_DOC = `Send it as \`Authorization: ApiKey ${KEY}\` on every request.`;

/** Source document first, then whatever the verification request should answer. */
function responder(verifyStatus: number) {
  return (req: HttpRequest): HttpResponse =>
    req.url === KEY_SOURCE_URL
      ? rawResponse(SOURCE_DOC, "text/plain")
      : verifyStatus === 200
        ? jsonResponse({ numFound: 0, documents: [] })
        : rawResponse("denied", "text/plain", verifyStatus);
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

test("obtainKey returns the key once the live API accepts it", async () => {
  const mt = makeMockTransport(responder(200));
  const result = await obtainKey({ transport: mt.transport });
  assert.equal(result.key, KEY);
  assert.equal(result.verified, true);
  // Two requests: read the source, then prove the key works.
  assert.equal(mt.calls.length, 2);
  assert.equal(mt.calls[1]?.headers?.["Authorization"], `ApiKey ${KEY}`);
});

test("obtainKey refuses a published key the API rejects", async () => {
  const mt = makeMockTransport(responder(401));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), (err: unknown) => {
    assert.ok(err instanceof DipError);
    assert.match(err.message, /no longer accepted/);
    assert.match(err.message, /dip\.bundestag\.de/);
    return true;
  });
});

test("obtainKey with verify:false skips the check and flags it", async () => {
  const mt = makeMockTransport(responder(401));
  const result = await obtainKey({ transport: mt.transport, verify: false });
  assert.equal(result.key, KEY);
  assert.equal(result.verified, false);
  assert.equal(mt.calls.length, 1);
});

test("obtainKey throws when the source states no key", async () => {
  const mt = makeMockTransport(() => rawResponse("# no key here", "text/plain"));
  await assert.rejects(() => obtainKey({ transport: mt.transport }), DipError);
});

test("obtain-key prints only the key on stdout, provenance on stderr", async () => {
  const cli = makeCli(responder(200));
  const code = await run(["obtain-key"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [KEY]);
  assert.match(cli.err.join("\n"), /verified it against the live API/);
});

test("obtain-key --export emits a quoted, eval-safe export line", async () => {
  const cli = makeCli(responder(200));
  const code = await run(["obtain-key", "--export"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [`export ${API_KEY_ENV_VAR}='${KEY}'`]);
});

test("a rejected key exits non-zero and prints nothing on stdout", async () => {
  const cli = makeCli(responder(401));
  const code = await run(["obtain-key"], cli.deps);
  assert.notEqual(code, 0);
  assert.deepEqual(cli.out, []);
});

test("--no-verify prints the candidate but warns loudly on stderr", async () => {
  const cli = makeCli(responder(401));
  const code = await run(["obtain-key", "--no-verify"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, [KEY]);
  assert.match(cli.err.join("\n"), /WITHOUT verifying/);
});
