import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { readEnvApiKey } from "../src/cli/program.js";
import { DipClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, untimed } from "./helpers.js";
import { DipError, DipNetworkError, credentialsIn } from "../src/client/errors.js";
import { cleartextCredentialsProblem, cleartextProblem } from "../src/index.js";

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
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[dip\.http\] connect ECONNREFUSED/);
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
  await run(["vorgang", "list", "--filter", "f.titel=a=b"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("f.titel"), "a=b");
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

// A blank --cursor or --id (often an unset shell variable) must be a usage error
// before any request — dropping it would silently run the list unfiltered.
const LIST_COMMANDS = [
  "vorgang",
  "vorgangsposition",
  "drucksache",
  "drucksache-text",
  "plenarprotokoll",
  "plenarprotokoll-text",
  "aktivitaet",
  "person",
];
const BLANK_CASES: Array<{ command: string; flag: string; value: string }> = [
  ...LIST_COMMANDS.flatMap((command) =>
    ["--cursor", "--id"].map((flag) => ({ command, flag, value: "" })),
  ),
  { command: "vorgang", flag: "--id", value: "   " },
  { command: "vorgang", flag: "--cursor", value: " \t " },
  { command: "vorgang", flag: "--filter", value: "f.id=" },
  { command: "drucksache", flag: "--filter", value: "f.titel=  " },
  { command: "person", flag: "--filter", value: " =x" },
];

for (const { command, flag, value } of BLANK_CASES) {
  test(`${command} list rejects a blank ${flag} (${JSON.stringify(value)}) before any request`, async () => {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["--api-key", "KEY", command, "list", flag, value], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
  });
}

test("a blank value among repeated --id values is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  const code = await run(["--api-key", "KEY", "vorgang", "list", "--id", "1", "--id", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

// A non-http(s) or malformed --base-url is a usage error at parse time, so the
// API key is never handed to a transport for a file:/ftp: URL.
for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
  test(`--base-url ${baseUrl} is rejected before any request`, async () => {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["--api-key", "KEY", "--base-url", baseUrl, "vorgang", "list"], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join(""), /--base-url/);
  });
}

test("get . / get .. is a usage error without a request instead of fetching the list or the root", async () => {
  for (const id of [".", ".."]) {
    const cli = makeCli(() => jsonResponse({ numFound: 1, documents: [] }));
    const code = await run(["--compact", "vorgang", "get", id], cli.deps);
    assert.equal(code, 2);
    assert.equal(cli.mt.calls.length, 0);
    assert.deepEqual(cli.out, []);
    assert.equal(untimed(cli.err.join("\n")), 'ERROR [dip.cli] Invalid vorgang id: "." and ".." cannot be used as an id.');
  }
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["1000000", false]] as const) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["--max-retries", value, "vorgang", "list"], cli.deps);
    assert.equal(code, ok ? 0 : 2, value);
    if (!ok) {
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /Expected an integer between 0 and 10\./);
    }
  }
});

test("an unknown or foreign --filter key is a usage error before any request", async () => {
  for (const [command, key] of [
    ["vorgang", "f.titl"], // typo
    ["vorgang", "titel"], // no f. prefix
    ["vorgang", "f.person"], // only person/aktivitaet have it
    ["vorgang", "f.vorgang"], // only vorgangsposition has it
    ["person", "f.nachname"],
    ["drucksache", "format"],
    ["drucksache", "apikey"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ numFound: 337303, documents: [] }));
    const code = await run(["--compact", command, "list", "--filter", `${key}=x`], cli.deps);
    assert.equal(code, 2, `${command} ${key}`);
    assert.equal(cli.mt.calls.length, 0);
    assert.deepEqual(cli.out, []);
    const err = cli.err.join("\n");
    assert.match(err, new RegExp(`Unknown filter "${key}" for ${command}\\. DIP ignores unknown filters`));
    assert.match(err, /Filters for \S+: f\.aktualisiert\.start, /);
  }
});

test("--filter cursor=... points at --cursor", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  const code = await run(["vorgang", "list", "--filter", "cursor=abc"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /"cursor" is a paging or sorting parameter, not a filter\. Use --cursor on list instead\./);
});

test("each resource accepts its own documented filters", async () => {
  for (const [command, key] of [
    ["vorgangsposition", "f.vorgang"],
    ["person", "f.person"],
    ["aktivitaet", "f.person_id"],
    ["drucksache", "f.zuordnung"],
    ["drucksache-text", "f.dokumentnummer"],
    ["plenarprotokoll", "f.aktualisiert.end"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    assert.equal(await run([command, "list", "--filter", `${key}=1`], cli.deps), 0, `${command} ${key}`);
    assert.equal(new URL(cli.mt.last().url).searchParams.get(key), "1");
  }
});

test("--base-url with a query, fragment, surrounding whitespace or /api/v1 is a usage error", async () => {
  for (const [value, message] of [
    ["http://localhost:18110/?s=ok", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["http://localhost:18110/#frag", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    [" https://search.dip.bundestag.de", /A base URL cannot have surrounding whitespace\./],
    [
      "https://search.dip.bundestag.de/api/v1",
      /Leave out \/api\/v1: the base URL is the host, and the client adds \/api\/v1 itself \(try https:\/\/search\.dip\.bundestag\.de\)\./,
    ],
    ["https://mirror.test/dip/api/v1/", /\(try https:\/\/mirror\.test\/dip\)/],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["--base-url", value, "vorgang", "list"], cli.deps);
    assert.equal(code, 2, value);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message, value);
  }
  // A mirror path prefix still works.
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  assert.equal(await run(["--base-url", "https://mirror.test/dip/", "vorgang", "list"], cli.deps), 0);
  assert.equal(cli.mt.last().url, "https://mirror.test/dip/api/v1/vorgang");
});

test("a password in --base-url never reaches an error message", async () => {
  const cli = makeCli(() => jsonResponse({ detail: "Not found" }, 404));
  const code = await run(["--base-url", "http://user:secret@localhost:18110/", "vorgang", "list"], cli.deps);
  assert.equal(code, 4);
  const err = cli.err.join("\n");
  assert.doesNotMatch(err, /secret|user:/);
  assert.match(untimed(err), /^ERROR \[dip\.api\] HTTP 404 for GET http:\/\/localhost:18110\/api\/v1\/vorgang: Not found/);
  // The userinfo goes out as Basic auth (a basic-auth mirror still works), attached by
  // the engine per hop; the transport never sees it in the URL.
  assert.equal(cli.mt.last().url, "http://localhost:18110/api/v1/vorgang");
  assert.equal(cli.mt.last().headers?.["Authorization"], `Basic ${Buffer.from("user:secret").toString("base64")}`);
});

test("prototype-named --filter keys are usage errors, not a crash", async () => {
  for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["vorgang", "list", "--filter", `${key}=x`], cli.deps);
    assert.equal(code, 2, key);
    assert.equal(cli.mt.calls.length, 0);
    const err = cli.err.join("\n");
    assert.doesNotMatch(err, /Unexpected error/);
    assert.match(err, new RegExp(`Unknown filter "${key}" for vorgang`));
  }
});

test("a blank --api-key is a usage error instead of silently discarding DIP_API_KEY", async () => {
  for (const value of ["", "   "]) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), { DIP_API_KEY: "ENVKEY" });
    const code = await run(["--api-key", value, "vorgang", "list"], cli.deps);
    assert.equal(code, 2, JSON.stringify(value));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /--api-key <key>.*Expected a non-empty value\./);
  }
});

test("control or non-Latin-1 characters in --api-key / --user-agent are usage errors", async () => {
  for (const [flag, value, message] of [
    ["--user-agent", "a\r\nX-Evil: 1", /Value contains control characters\./],
    ["--api-key", "k\r\nX-Evil: 1", /Value contains control characters\./],
    ["--api-key", "k\u20ac", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
    ["--user-agent", "", /Expected a non-empty value\./],
    ["--user-agent", "  ", /Expected a non-empty value\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run([flag, value, "vorgang", "list"], cli.deps);
    assert.equal(code, 2, `${flag} ${JSON.stringify(value)}`);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
    assert.doesNotMatch(cli.err.join("\n"), /Unexpected error/);
  }
  // Tab and Latin-1 are sendable and stay allowed.
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  assert.equal(await run(["--user-agent", "m\u00fcnchen\tbot", "vorgang", "list"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "m\u00fcnchen\tbot");
});

test("a DIP_API_KEY with control characters is a usage error, not an unexpected one", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), { DIP_API_KEY: "a\nb" });
  const code = await run(["vorgang", "list"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[dip\.cli\] Invalid apiKey: Value contains control characters\./);
});

test("an empty list response exits 1 instead of printing null", async () => {
  const cli = makeCli(() => ({ status: 200, headers: {}, body: Buffer.alloc(0) }));
  const code = await run(["--compact", "vorgang", "list"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[dip\.cli\] Empty response body from \/api\/v1\/vorgang/);
});

test("a blank -o is a usage error before any request", async () => {
  for (const value of ["", " "]) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
    const code = await run(["-o", value, "vorgang", "list"], cli.deps);
    assert.equal(code, 2, JSON.stringify(value));
    assert.equal(cli.mt.calls.length, 0);
    assert.equal(cli.files.size, 0);
    assert.match(cli.err.join("\n"), /Expected a non-empty value\./);
  }
});

test("-o - prints to stdout instead of writing a file named -", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 1, documents: [{ id: "1" }] }));
  const code = await run(["--compact", "-o", "-", "vorgang", "list"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(cli.out, ['{"numFound":1,"documents":[{"id":"1"}]}']);
  assert.equal(cli.files.size, 0);
  assert.doesNotMatch(cli.err.join("\n"), /Wrote/);
});

test("an overwrite refusal is a clear error, not an unexpected one", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  cli.deps.io.writeFile = (path) => {
    throw new DipError(`Refusing to overwrite existing file "${path}"; pass --force to overwrite.`);
  };
  const code = await run(["-o", "out.json", "vorgang", "list"], cli.deps);
  assert.equal(code, 1);
  assert.match(untimed(cli.err.join("\n")), /^ERROR \[dip\.cli\] Refusing to overwrite existing file "out\.json"; pass --force to overwrite\./);
});

test("a response nested too deeply to pretty-print is a clear error, not a stack overflow", async () => {
  const depth = 200_000;
  // Nested inside a valid list envelope, which the client checks first.
  const body = Buffer.from(`{"numFound":1,"documents":[{"id":"1","x":${"[".repeat(depth)}${"]".repeat(depth)}}]}`);
  const deep = () => ({ status: 200, headers: { "content-type": "application/json" }, body });
  const pretty = makeCli(deep);
  assert.equal(await run(["vorgang", "list"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.match(untimed(pretty.err.join("\n")), /^ERROR \[dip\.cli\] The response is nested too deeply to pretty-print; try --compact\./);
  // Compact output needs far less stack: it either prints or fails with the compact message.
  const compact = makeCli(deep);
  const code = await run(["--compact", "vorgang", "list"], compact.deps);
  if (code !== 0) assert.match(untimed(compact.err.join("\n")), /^ERROR \[dip\.cli\] The response is nested too deeply to print\./);
});

test("a plain-http base URL is warned about, naming a key or userinfo; loopback and https are not", async () => {
  const cases: Array<[string[], Record<string, string>, RegExp | undefined]> = [
    [["--base-url", "http://search.dip.bundestag.de", "--api-key", "k3y-value"], {}, /^WARN  \[dip\.http\] the API key is sent unencrypted to search\.dip\.bundestag\.de \(http:, not https:\)$/],
    [["--base-url", "http://search.dip.bundestag.de"], { DIP_API_KEY: "k3y-value" }, /the API key is sent unencrypted/],
    [["--base-url", "http://u:pw@mirror.test"], {}, /^WARN  \[dip\.http\] the base URL's credentials are sent unencrypted to mirror\.test \(http:, not https:\)$/],
    [["--base-url", "http://u:pw@mirror.test", "--api-key", "k3y-value"], {}, /^WARN  \[dip\.http\] the API key and the base URL's credentials are sent unencrypted to mirror\.test/],
    [["--base-url", "http://mirror.test:8080"], {}, /^WARN  \[dip\.http\] requests to mirror\.test:8080 are sent unencrypted \(http:, not https:\)$/],
    [["--base-url", "http://127.0.0.1:20180", "--api-key", "k3y-value"], {}, undefined],
    [["--base-url", "http://localhost:20180", "--api-key", "k3y-value"], {}, undefined],
    [["--api-key", "k3y-value"], {}, undefined],
  ];
  for (const [args, env, expected] of cases) {
    const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }), env);
    assert.equal(await run([...args, "vorgang", "list"], cli.deps), 0, args.join(" "));
    const warnings = cli.err.map(untimed).filter((l) => l.startsWith("WARN "));
    if (expected === undefined) assert.deepEqual(warnings, [], args.join(" "));
    else {
      assert.equal(warnings.length, 1, args.join(" "));
      assert.match(warnings[0]!, expected, args.join(" "));
    }
    assert.ok(!cli.err.join("\n").includes("pw@"), "the warning never shows the credentials");
    assert.ok(!cli.err.join("\n").includes("k3y-value"), "the warning never shows the key");
  }
});

test("cleartextProblem: loopback by address only, every secret named, none printed", () => {
  assert.equal(cleartextProblem("http://127.1:9"), undefined);
  assert.equal(cleartextProblem("not a url"), undefined);
  assert.match(cleartextProblem("http://127.example:9") ?? "", /^requests to 127\.example:9 are sent/);
  assert.equal(
    cleartextProblem("http://a:b@mirror.test", ["the API key", "the token"]),
    "the API key, the token and the base URL's credentials are sent unencrypted to mirror.test (http:, not https:)",
  );
  // The deprecated name keeps its contract: nothing to say when no secret goes out.
  assert.equal(cleartextCredentialsProblem("http://mirror.test", false), undefined);
  assert.equal(
    cleartextCredentialsProblem("http://mirror.test", true),
    "the API key is sent unencrypted to mirror.test (http:, not https:)",
  );
});

test("a 2xx body that is not a DIP list or document exits 1 instead of printing it", async () => {
  const cases: Array<[string[], unknown]> = [
    [["vorgang", "list"], null],
    [["vorgang", "list"], []],
    [["vorgang", "list"], { error: "invalid api key", code: 401 }],
    [["vorgang", "list"], { numFound: 3 }],
    [["vorgang", "get", "1"], null],
    [["person", "get", "14"], "hello"],
    [["person", "get", "14"], { error: "invalid api key", code: 401 }],
    [["person", "get", "14"], { numFound: 0, documents: [] }],
  ];
  for (const [argv, body] of cases) {
    const cli = makeCli(() => jsonResponse(body));
    assert.equal(await run(["-o", "out.json", ...argv], cli.deps), 1, `${argv.join(" ")} ${JSON.stringify(body)}`);
    assert.deepEqual(cli.out, []);
    assert.equal(cli.files.size, 0, "no file is written");
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[dip\.cli\] Unexpected response from \/api\/v1\//);
  }
  const ok = makeCli(() => jsonResponse({ id: "14", nachname: "Merkel" }));
  assert.equal(await run(["person", "get", "14"], ok.deps), 0);
});

test("a --cursor without any filter is a usage error before any request; with its filters it is sent", async () => {
  const page = { numFound: 2, documents: [{ id: "1" }], cursor: "AoJ" };
  // With an http base URL too: the refusal comes before the plain-http warning.
  const bare = makeCli(() => jsonResponse(page));
  assert.equal(await run(["--base-url", "http://mirror.test", "vorgangsposition", "list", "--cursor", "AoJ"], bare.deps), 2);
  assert.deepEqual(bare.out, []);
  assert.deepEqual(bare.err.map(untimed), [
    "ERROR [dip.cli] --cursor needs the filters of the page it came from: DIP does not keep them in the cursor, so a " +
      "cursor alone pages through the whole unfiltered vorgangsposition list. Repeat every --filter and --id " +
      "of that page together with --cursor.",
  ]);
  assert.equal(bare.mt.calls.length, 0);
  for (const extra of [["--filter", "f.vorgang=298723"], ["--id", "1"]]) {
    const filtered = makeCli(() => jsonResponse(page));
    assert.equal(await run(["vorgangsposition", "list", ...extra, "--cursor", "AoJ"], filtered.deps), 0);
    assert.deepEqual(filtered.err, [], extra.join(" "));
    assert.match(filtered.mt.calls[0]?.url ?? "", /cursor=AoJ/);
  }
  const first = makeCli(() => jsonResponse(page));
  assert.equal(await run(["vorgangsposition", "list"], first.deps), 0);
  assert.deepEqual(first.err, [], "an unfiltered first page is fine");
});

test("dip help <unknown> reports the unknown command like dip <unknown>, at every level", async () => {
  const cases: Array<[string[], string[]]> = [
    [["help", "nope"], ["nope"]],
    [["help", "vorgnag"], ["vorgnag"]],
    [["help", "vorgang", "nope"], ["vorgang", "nope"]],
    [["vorgang", "help", "nope"], ["vorgang", "nope"]],
    [["help", "https://alice:s3cret@x.test"], ["https://alice:s3cret@x.test"]],
  ];
  for (const [helpArgv, plainArgv] of cases) {
    const viaHelp = makeCli(() => jsonResponse({}));
    const plain = makeCli(() => jsonResponse({}));
    assert.equal(await run(helpArgv, viaHelp.deps), 2, helpArgv.join(" "));
    assert.equal(await run(plainArgv, plain.deps), 2, plainArgv.join(" "));
    assert.match(untimed(viaHelp.err[0] ?? ""), /^ERROR \[dip\.cli\] unknown command '/, helpArgv.join(" "));
    assert.deepEqual(viaHelp.err.map(untimed), plain.err.map(untimed), helpArgv.join(" "));
    assert.deepEqual(viaHelp.out, []);
    assert.ok(!viaHelp.err.join("\n").includes("s3cret"));
    assert.equal(viaHelp.mt.calls.length, 0);
  }
});

test("dip help <command path> shows that command's help on stdout, exit 0", async () => {
  for (const [argv, usage] of [
    [["help"], "Usage: dip [options] [command]"],
    [["help", "vorgang"], "Usage: dip vorgang [options] [command]"],
    [["help", "vorgang", "list"], "Usage: dip vorgang list [options]"],
    [["vorgang", "help", "get"], "Usage: dip vorgang get [options] <id>"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 0, argv.join(" "));
    assert.equal(cli.out.join("\n").split("\n")[0], usage, argv.join(" "));
    assert.deepEqual(cli.err, []);
  }
});

test("a rejected --filter value is quoted at most 200 characters long (L3)", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 0, documents: [] }));
  // commander echoes the whole value itself (the record's cap bounds that); dip's own
  // message quotes it cut.
  assert.equal(await run(["vorgang", "list", "--filter", `f.id=${"9x".repeat(500)}`], cli.deps), 2);
  const record = cli.err.find((line) => line.includes("Invalid --filter")) ?? "";
  const own = record.slice(record.indexOf("Invalid --filter"));
  assert.match(own, /^Invalid --filter "f\.id=(9x)+9?…": f\.id: /);
  assert.ok(own.length < 400, `${own.length}`);
});

test("an a:b@c argument (here a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ numFound: 1, documents: [{ id: "1", titel: "run:2026-10-09@x" }] }));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "vorgang", "list"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"titel": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
});
