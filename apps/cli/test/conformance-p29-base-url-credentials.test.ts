// Conformance test P29 (security audit 2026-10-27, classes B, E and F): the base URL's
// credentials go only to the host every check names, and the redaction of a run stays whole and
// linear.
// - A userinfo without a password (`https://TOKEN@host`, `https://TOKEN:@host`) is a token: the
//   user name is the secret, and its echoed forms (the token, `TOKEN:`, the Basic value of
//   `TOKEN:`) are scrubbed from library errors and from what the CLI prints. They were not
//   redacted at all.
// - A backslash in a base URL is refused, by the library and by --base-url: WHATWG ends an
//   http(s) authority at `\`, the text-based credential and request-base code did not, so
//   `https://alice:pw@api.example\@evil.example` sent Basic credentials to one host while the
//   checks and the cleartext warning looked at another. The request goes to the host of the
//   parsed base URL, an `@` in its path included.
// - A base URL whose scheme is not followed by exactly `//` and the host (`http:host`,
//   `http:/host`, `http:///host`, `https:\\host`) is refused too: WHATWG skips the slashes and
//   backslashes there and repairs the URL silently, so the host requested was not the one typed.
//   The userinfo of such a value starts after them, so a refused one is never echoed with its
//   password (it was: `http:///alice:pw@host`), nor is one whose scheme is missing or mistyped
//   (`http//alice:pw@host`, `htp:/alice:pw@host`, `alice:pw@host`).
// - The userinfo redaction of what the CLI prints (when an argument carries a URL with
//   userinfo, every stdout text) is linear: the scheme regex it replaces was quadratic on a run of
//   scheme characters (`a.a.a.…`) in an answer and held the run for seconds.
// Shared across the *-cli repos; only the adapter differs.

import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
import { credentialsIn } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";

// ---- adapter (per repo) -------------------------------------------------------------
import { test as nodeTest } from "node:test";
import { DipClient as Client } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
/** `parity(argv, call, responder)` as in P24 (dip's `kitParity`). */
import { kitParity as parity } from "./helpers.js";
/**
 * CLI argv (after the global options) for one GET whose answer carries a free-form value, and the
 * same call in the library. The base URL's credentials are this kit test's subject; the API key
 * (`--api-key`, DIP_API_KEY, the credentials file) is redacted by P1/P2 and scrubbed in the
 * client's engine.test.ts.
 */
const call = ["vorgang", "get", "1"];
const lib = (client: Client): Promise<unknown> => client.vorgaenge.get("1");
/** The raw 2xx body with `json` (a JSON value, written as is) as that value. */
const bodyWith = (json: string): string => `{"id":"1","x":${json}}`;
/** An error body (any status) whose message the client quotes, with `text` as that message. */
const errorBody = (text: string): string => JSON.stringify({ message: text });
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
/**
 * dip's stdout replaces the userinfo of the URLs argv typed (and the forms a server echoes them
 * in) by exact match; it has no pattern pass over the answer, so there is no glued URL to miss
 * and an answer's own `u:p@` stays as the API sent it.
 */
const SKIPPED: Record<string, string> = {
  "P29: the CLI's redaction of stdout hides the userinfo of a URL glued onto the one before it":
    "stdout hides the userinfo of argv's URLs as typed, by exact match; there is no pattern pass over the answer",
};
const test = (name: string, fn: () => void | Promise<void>): void => {
  void nodeTest(name, SKIPPED[name] === undefined ? {} : { skip: SKIPPED[name] }, fn);
};
// --------------------------------------------------------------------------------------

const response = (status: number, body: string): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: Buffer.from(body, "utf8"),
});

function everything(value: unknown): string {
  let text = inspect(value, { depth: 10, showHidden: true });
  if (value instanceof Error) {
    const e = value as Error & { detail?: unknown; body?: unknown; url?: unknown };
    text += [e.message, e.detail, e.body, e.url].map(String).join("\n");
  }
  return text;
}

async function failure(baseUrl: string, transport: (req: HttpRequest) => Promise<HttpResponse>): Promise<unknown> {
  const client = new Client({ baseUrl, transport, maxRetries: 0 });
  try {
    await lib(client);
  } catch (err) {
    return err;
  }
  return assert.fail("the call should have failed");
}

const TOKEN = "T0kenS3cret";
const basicOf = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");

test("P29: a userinfo without a password is a token: scrubbed from library errors in every echoed form", async () => {
  for (const base of [`https://${TOKEN}@mirror.example`, `https://${TOKEN}:@mirror.example`]) {
    const echoes = [`bad token ${TOKEN}`, `Authorization: Basic ${basicOf(`${TOKEN}:`)}`, `user ${TOKEN}: unknown`];
    for (const echo of echoes) {
      const err = await failure(base, async () => response(401, errorBody(echo)));
      const seen = everything(err);
      assert.ok(err instanceof Error && /^HTTP 401 /.test(err.message), String(err));
      assert.ok(!seen.includes(TOKEN) && !seen.includes(basicOf(`${TOKEN}:`)), `${base} ${echo}: ${seen.slice(0, 2000)}`);
    }
  }
});

test("P29: a token in --base-url is redacted from what the CLI prints, on stderr and stdout", async () => {
  const base = `https://${TOKEN}@mirror.example`;
  // An error answer that echoes the token: stderr.
  const failed = await parity(["--base-url", base, "--max-retries", "0", ...call], (t) => lib(new Client({ baseUrl: base, transport: t, maxRetries: 0 })), () =>
    response(401, errorBody(`bad token ${TOKEN}`)),
  );
  assert.notEqual(failed.cli.code, 0);
  assert.ok(!failed.cli.err.includes(TOKEN), failed.cli.err);
  // A 2xx answer that echoes the Basic value and `TOKEN:`: stdout.
  const echoed = await parity(["--base-url", base, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })), () =>
    response(200, bodyWith(JSON.stringify(`Basic ${basicOf(`${TOKEN}:`)} for ${TOKEN}:x`))),
  );
  assert.equal(echoed.cli.code, 0, echoed.cli.err);
  assert.ok(!echoed.cli.out.includes(basicOf(`${TOKEN}:`)) && !echoed.cli.out.includes(`${TOKEN}:`), echoed.cli.out);
});

test("P29: a backslash in the base URL is refused by the library and by --base-url, never echoing the password", async () => {
  const pw = "s3cret-Pw";
  for (const base of [`https://alice:${pw}@api.example\\@evil.example`, "https://api.example\\evil", `http://alice:${pw}@127.0.0.1\\@evil.example`]) {
    let refused: unknown;
    try {
      new Client({ baseUrl: base });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof Error && /backslash/.test(refused.message), `${base}: ${String(refused)}`);
    assert.ok(!everything(refused).includes(pw), everything(refused));
    const o = await parity(["--base-url", base, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })));
    assert.equal(o.cli.code, USAGE_EXIT, `${base}: ${o.cli.err}`);
    assert.equal(o.cli.requests.length, 0);
    assert.match(o.cli.err, /backslash/);
    assert.ok(!o.cli.err.includes(pw), o.cli.err);
  }
});

test("P29: a base URL whose scheme is not followed by exactly // and the host is refused by the library and by --base-url, never echoing the password", async () => {
  // WHATWG skips any slashes and backslashes after "http:" and repairs the URL silently, so the
  // host requested was not the one typed, and a userinfo read after "://" was missed: commander
  // echoed `http:///alice:pw@host` with the password in clear.
  const pw = "s3cret-Pw";
  for (const base of [
    `http:alice:${pw}@127.0.0.1:9`,
    `http:/alice:${pw}@127.0.0.1:9`,
    `http:///alice:${pw}@127.0.0.1:9`,
    `HTTPS:alice:${pw}@mirror.example`,
    `https:\\\\alice:${pw}@mirror.example`,
    `http:///alice:${pw}@mirror.example/?q=1`,
  ]) {
    let refused: unknown;
    try {
      new Client({ baseUrl: base });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused instanceof Error, `${base}: accepted`);
    assert.ok(!everything(refused).includes(pw), everything(refused));
    const o = await parity(["--base-url", base, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })));
    assert.equal(o.cli.code, USAGE_EXIT, `${base}: ${o.cli.err}`);
    assert.equal(o.cli.requests.length, 0);
    assert.equal(o.lib.requests.length, 0);
    assert.ok(!o.cli.err.includes(pw) && !o.cli.out.includes(pw), o.cli.err);
  }
  for (const base of [`http:alice:${pw}@mirror.example`, `https:/mirror.example`, `http:///mirror.example`]) {
    const o = await parity(["--base-url", base, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })));
    assert.match(o.cli.err, /"https:\/\/" and the host/, base);
  }
});

test("P29: a base URL with its scheme missing or mistyped is refused by --base-url, never echoing the password or token", async () => {
  // Commander quotes the rejected value; the run's redaction knew the userinfo only after a
  // scheme with its colon, so `http//alice:pw@host` (the colon left out) was echoed in clear.
  const pw = "s3cret-Pw";
  for (const base of [
    `http//alice:${pw}@127.0.0.1:9`,
    `https//alice:${pw}@127.0.0.1:9/v1`,
    `http/alice:${pw}@127.0.0.1:9`,
    `htp:/alice:${pw}@127.0.0.1:9`,
    `http\\\\alice:${pw}@127.0.0.1:9`,
    `http//alice:${pw}/x@127.0.0.1:9`,
    `alice:${pw}@127.0.0.1:9`,
    `my_user:${pw}@127.0.0.1:9`,
    `${TOKEN}:@127.0.0.1:9`,
  ]) {
    for (const argv of [["--base-url", base], [`--base-url=${base}`]]) {
      const o = await parity([...argv, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })));
      assert.equal(o.cli.code, USAGE_EXIT, `${base}: ${o.cli.err}`);
      assert.equal(o.cli.requests.length, 0);
      const printed = o.cli.err + o.cli.out;
      assert.ok(!printed.includes(pw) && !printed.toLowerCase().includes(TOKEN.toLowerCase()), printed);
    }
  }
});

test("P29: the userinfo a URL carries ends where WHATWG ends the authority, at a backslash too", () => {
  assert.deepEqual(credentialsIn("https://alice:pw@api.example\\@evil.example/x"), ["alice:pw"]);
  assert.deepEqual(credentialsIn("http://alice:pw@h.example\\x"), ["alice:pw"]);
  assert.deepEqual(credentialsIn("https://alice:pw@api.example/v1/@x"), ["alice:pw"]);
  // And starts where WHATWG starts it: after the slashes and backslashes a special scheme skips.
  for (const value of ["http:alice:pw@h.example", "http:/alice:pw@h.example", "http:///alice:pw@h.example/x", "HTTPS:\\\\alice:pw@h.example"]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
  }
});

test("P29: requests go to the host of the parsed base URL, spelled as it parses, an @ in its path included", async () => {
  for (const base of ["https://alice:pw@api.example/v1/@evil.example", "https://API.Example:443/v1"]) {
    const parsed = new URL(base);
    const o = await parity(["--base-url", base, ...call], (t) => lib(new Client({ baseUrl: base, transport: t })), () => response(200, bodyWith("1")));
    assert.equal(o.cli.requests.length, 1, o.cli.err);
    assert.equal(o.lib.requests.length, 1);
    for (const req of [...o.cli.requests, ...o.lib.requests]) {
      assert.equal(new URL(req.url).origin, parsed.origin, `${base}: ${req.url}`);
      // The URL as sent names that host in the text too, so a transport that reads the string
      // (not the parsed URL) reaches the same host.
      const authority = req.url.slice(req.url.indexOf("//") + 2).split("/")[0] ?? "";
      assert.ok(authority === parsed.host || authority.endsWith(`@${parsed.host}`), `${base}: ${req.url}`);
    }
  }
});

test("P29: the CLI's redaction of stdout is linear in the answer", async () => {
  // With a URL with userinfo in argv, every stdout text is redacted. 200 000 characters of
  // `a.a.…` took about 8 s with the scheme regex; the linear pass takes milliseconds.
  const base = `https://alice:s3cret-Pw@mirror.example`;
  const value = "a.".repeat(100_000);
  const start = performance.now();
  const o = await parity(["--base-url", base, "--compact", ...call], (t) => lib(new Client({ baseUrl: base, transport: t })), () =>
    response(200, bodyWith(JSON.stringify(value))),
  );
  const ms = performance.now() - start;
  assert.equal(o.cli.code, 0, o.cli.err);
  assert.ok(o.cli.out.includes(value));
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test("P29: the CLI's redaction of stdout hides the userinfo of a URL glued onto the one before it", async () => {
  // The linear pass read the first URL's authority up to the second `://` and searched on after
  // it, so the second URL's userinfo reached stdout; the scheme regex it replaced redacted both.
  const base = `https://alice:s3cret-Pw@mirror.example`;
  const value = "https://host://u:p1@h and https://u:p2@x://v:q3@w";
  const o = await parity(["--base-url", base, "--compact", ...call], (t) => lib(new Client({ baseUrl: base, transport: t })), () =>
    response(200, bodyWith(JSON.stringify(value))),
  );
  assert.equal(o.cli.code, 0, o.cli.err);
  assert.ok(o.cli.out.includes("https://host://***@h and https://***@x://***@w"), o.cli.out);
  for (const secret of ["u:p1", "u:p2", "v:q3"]) assert.ok(!o.cli.out.includes(secret), o.cli.out);
});
