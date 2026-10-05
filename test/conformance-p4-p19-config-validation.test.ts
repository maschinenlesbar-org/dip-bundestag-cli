// Conformance test P4 + P19 (fix plan 2026-10-06): a base URL the client can't use fails as a
// usage error before any request (P4), and help works whatever an environment variable holds
// (P19). Shared across the *-cli repos; only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "../src/client/client.js";
import { DipValidationError as ValidationError } from "../src/client/errors.js";
const BASE_URL_ENV: string | undefined = undefined; // dip reads no base-URL variable
const SIMPLE_COMMAND = ["vorgang", "list"];
const USAGE_EXIT = 2;
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = { writeFile: () => {}, outBinary: () => {} };
/** Keyed repos: the key variable, and a value the client rejects. */
const KEY_ENV: string | undefined = "DIP_API_KEY";
const BAD_KEY_VALUE = "Pers0nal.QwErTyUiOpAsDfGhJkLzXcVbNm1234567890\u200b";
// --------------------------------------------------------------------------------------

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let requests = 0;
  const transport = async (): Promise<HttpResponse> => {
    requests++;
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ numFound: 0, documents: [] })) };
  };
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env,
    createClient: (opts) => new Client({ ...opts, transport }),
    transport,
  };
  return { deps, out, err, requests: () => requests };
}

test("P4: a '%' that isn't an escape in the userinfo is a usage error before any request", async () => {
  for (const url of ["https://alice:100%@mirror.example", "https://alice:pa%zzss@mirror.example", "https://al%ice:pw@mirror.example"]) {
    const c = cli();
    const code = await run(["--base-url", url, ...SIMPLE_COMMAND], c.deps);
    assert.equal(code, USAGE_EXIT, `${url}: ${c.err.join("\n")}`);
    assert.equal(c.requests(), 0);
    assert.match(c.err.join("\n"), /%25/);
    assert.throws(() => new Client({ baseUrl: url }), ValidationError);
  }
  // An escaped "%" is fine.
  assert.doesNotThrow(() => new Client({ baseUrl: "https://alice:100%25@mirror.example" }));
});

test("P19: help works whatever the base-URL variable holds", async (t) => {
  if (BASE_URL_ENV === undefined) return t.skip("this CLI reads no base-URL variable");
  for (const value of ["not a url", "http://x:99999", "ftp://h", " "]) {
    for (const argv of [["--help"], ["help"], ["help", ...SIMPLE_COMMAND], [...SIMPLE_COMMAND, "--help"]]) {
      const c = cli({ [BASE_URL_ENV]: value });
      const code = await run(argv, c.deps);
      assert.equal(code, 0, `${BASE_URL_ENV}=${JSON.stringify(value)} ${argv.join(" ")}: ${c.err.join("\n")}`);
    }
    // A command that uses it still fails as a usage error.
    const c = cli({ [BASE_URL_ENV]: value });
    assert.equal(await run(SIMPLE_COMMAND, c.deps), USAGE_EXIT);
  }
});

test("P19 (keyed): help works whatever the key variable holds", async (t) => {
  if (KEY_ENV === undefined) return t.skip("this CLI reads no key variable");
  for (const argv of [["--help"], ["help"], ["help", ...SIMPLE_COMMAND], [...SIMPLE_COMMAND, "--help"], ["obtain-key", "--help"]]) {
    const c = cli({ [KEY_ENV]: BAD_KEY_VALUE });
    const code = await run(argv, c.deps);
    assert.equal(code, 0, `${KEY_ENV} ${argv.join(" ")}: ${c.err.join("\n")}`);
    assert.equal(c.requests(), 0);
  }
  // A command that uses it still fails as a usage error, before any request.
  const c = cli({ [KEY_ENV]: BAD_KEY_VALUE });
  assert.equal(await run(SIMPLE_COMMAND, c.deps), USAGE_EXIT);
  assert.equal(c.requests(), 0);
});
