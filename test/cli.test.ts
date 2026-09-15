import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { readEnvApiKey } from "../src/cli/program.js";
import { DipClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";
import { DipNetworkError } from "../src/client/errors.js";

const API = "/api/v1";

function makeCli(
  responder: (req: HttpRequest) => HttpResponse,
  env: Record<string, string | undefined> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => new DipClient({ ...opts, transport: mt.transport }),
    env,
  };
  return { deps, out, err, files, mt };
}

test("vorgang list sends no Authorization when no key is configured", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  const code = await run(["vorgang", "list"], cli.deps);
  assert.equal(code, 0);
  const req = cli.mt.last();
  // No key is bundled: without --api-key/DIP_API_KEY the header is omitted.
  assert.equal(req.headers?.["Authorization"], undefined);
  assert.equal(new URL(req.url).pathname, `${API}/vorgang`);
});

test("--api-key overrides the Authorization header", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  await run(["--api-key", "KEY123", "drucksache", "list"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], "ApiKey KEY123");
});

test("list --filter and repeatable --id build the query", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  await run(
    ["vorgang", "list", "--filter", "f.titel=Klima", "--id", "1", "--id", "2"],
    cli.deps,
  );
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("f.titel"), "Klima");
  assert.deepEqual(url.searchParams.getAll("f.id"), ["1", "2"]);
});

test("list rejects a malformed --filter before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["vorgang", "list", "--filter", "nope"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("get builds the per-id path", async () => {
  const cli = makeCli(() => jsonResponse({ id: "1" }));
  await run(["person", "get", "777"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, `${API}/person/777`);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { id: "777", nachname: `Muster${controls}`, vorname: String.fromCharCode(0x1b) + "[31m" };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "person", "get", "777"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Muster\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ id: "777" }));
  assert.equal(await run(["--timeout", "2147483647", "person", "get", "777"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({ id: "777" }));
  assert.equal(await run(["--timeout", "2147483648", "person", "get", "777"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /between 0 and 2147483647/);
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["drucksache", "get", "nope"], cli.deps);
  assert.equal(code, 4);
});

test("a 401 exits 1 and prints an actionable key hint", async () => {
  const cli = makeCli(() => jsonResponse({ message: "key required" }, 401));
  const code = await run(["vorgang", "list"], cli.deps);
  assert.equal(code, 1);
  const text = cli.err.join("\n");
  assert.match(text, /401/);
  assert.match(text, /api key/i);
  assert.match(text, /--api-key|DIP_API_KEY/);
  assert.match(text, /parlamentsdokumentation@bundestag\.de/);
  assert.match(text, /https:\/\/dip\.bundestag\.de\/über-dip\/hilfe\/api/);
});

test("a network failure maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new DipNetworkError("connect ECONNREFUSED");
  });
  const code = await run(["vorgang", "list"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: connect ECONNREFUSED/);
});

test("DIP_API_KEY from the env populates the Authorization header", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), {
    // Surrounding whitespace must be trimmed.
    DIP_API_KEY: "  ENVKEY  ",
  });
  await run(["vorgang", "list"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], "ApiKey ENVKEY");
});

test("--api-key overrides DIP_API_KEY", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), {
    DIP_API_KEY: "ENVKEY",
  });
  await run(["--api-key", "FLAGKEY", "vorgang", "list"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], "ApiKey FLAGKEY");
});

test("a blank DIP_API_KEY is treated as unset (no malformed header)", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), {
    DIP_API_KEY: "   ",
  });
  await run(["--api-key", "REAL", "vorgang", "list"], cli.deps);
  assert.equal(cli.mt.last().headers?.["Authorization"], "ApiKey REAL");
});

test("--filter accepts a value containing '='", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  await run(["vorgang", "list", "--filter", "f.datum=2024=x"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("f.datum"), "2024=x");
});

test("readEnvApiKey trims and treats blank/missing as undefined", () => {
  assert.equal(readEnvApiKey({ DIP_API_KEY: "  abc  " }), "abc");
  assert.equal(readEnvApiKey({ DIP_API_KEY: "   " }), undefined);
  assert.equal(readEnvApiKey({ DIP_API_KEY: "" }), undefined);
  assert.equal(readEnvApiKey({}), undefined);
});

test("--id and --filter f.id are merged, not clobbered", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  await run(
    ["vorgang", "list", "--filter", "f.id=9", "--id", "1", "--id", "2"],
    cli.deps,
  );
  const url = new URL(cli.mt.last().url);
  assert.deepEqual(url.searchParams.getAll("f.id"), ["9", "1", "2"]);
});
