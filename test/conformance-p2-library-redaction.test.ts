// Conformance test P2 (fix plan 2026-10-06): a library user who logs a client or an error —
// console.log, util.inspect, JSON.stringify, `.message`, `.url`, the `cause` chain — never
// sees a password from the base URL. Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { DipClient as Client } from "../src/client/client.js";
import { obtainKey } from "../src/client/obtain-key.js";
/** One call that makes a single GET and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.vorgaenge.list();
/** A 2xx body the call accepts. */
const okBody = { numFound: 0, documents: [] };
/** Keyed repos: the client option that takes the key (undefined if the client takes none). */
const KEY_OPTION: string | undefined = "apiKey";
// --------------------------------------------------------------------------------------

const PW = "s3cret-Pw";
const BASE = `https://alice:${PW}@mirror.example`;

function everything(value: unknown): string {
  let text = inspect(value, { depth: 10, showHidden: true });
  try {
    text += JSON.stringify(value);
  } catch {
    // circular: inspect covers it
  }
  if (value instanceof Error) {
    text += value.message + String((value as { url?: unknown }).url ?? "");
    for (let c: unknown = value.cause; c !== undefined && c !== null; c = (c as { cause?: unknown }).cause) {
      text += inspect(c, { depth: 10 }) + (c instanceof Error ? c.message : String(c));
    }
  }
  return text;
}

async function failure(transport: (req: HttpRequest) => Promise<HttpResponse>): Promise<unknown> {
  const client = new Client({ baseUrl: BASE, transport, maxRetries: 0 });
  try {
    await call(client);
  } catch (err) {
    return err;
  }
  return assert.fail("the call should have failed");
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

test("P2: logging a client never shows the password", () => {
  const client = new Client({ baseUrl: BASE, transport: async () => json(200, okBody) });
  assert.ok(!everything(client).includes(PW), everything(client));
});

test("P2: no error a call can raise carries the password", async () => {
  const cases: Array<[string, (req: HttpRequest) => Promise<HttpResponse>]> = [
    ["HTTP 404", async () => json(404, { message: "not here" })],
    ["HTTP 500", async () => json(500, { message: "boom" })],
    ["HTTP 503 with an echoing body", async (req) => json(503, { message: `bad ${req.url}` })],
    ["redirect", async () => json(301, "", { location: `https://alice:${PW}@elsewhere.example/x` })],
    ["parse error", async () => json(200, "not json")],
    ["empty body", async () => json(200, "")],
    ["transport throws with the URL in its message", async (req) => { throw new TypeError(`Failed to fetch ${req.url}`); }],
    ["transport throws a string with the URL", async (req) => { throw `cannot reach ${req.url}`; }],
    ["transport throws a nested cause with the URL", async (req) => { throw new Error("fetch failed", { cause: new Error(`connect to ${req.url}`) }); }],
  ];
  for (const [label, transport] of cases) {
    const err = await failure(transport);
    assert.ok(!everything(err).includes(PW), `${label}: ${everything(err)}`);
  }
});

test("P2: rejected base URLs are not echoed by the constructor", () => {
  for (const baseUrl of [`${BASE}/?x=1`, `${BASE}:99999`, `https://alice:pa#${PW}@mirror.example`, `${BASE} `, `ftp://alice:${PW}@h`]) {
    try {
      new Client({ baseUrl });
      assert.fail(`accepted ${baseUrl}`);
    } catch (err) {
      assert.ok(!everything(err).includes(PW), `${baseUrl}: ${everything(err)}`);
    }
  }
});

// ---- keyed repos: the API key and a key source behind Basic auth ----------------------

const KEY = "SeKrEt1.abcdefghijklmnopqrstuvwxyz0123456789";

test("P2 (keyed): neither a logged client nor an error shows the API key", async (t) => {
  if (KEY_OPTION === undefined) return t.skip("this client takes no key");
  const echo = async (req: HttpRequest): Promise<HttpResponse> =>
    json(401, { message: `rejected ${JSON.stringify(req.headers)} for ${req.url}` });
  const client = new Client({ [KEY_OPTION]: KEY, transport: echo, maxRetries: 0 } as ConstructorParameters<typeof Client>[0]);
  assert.ok(!everything(client).includes(KEY), everything(client));
  try {
    await call(client);
    assert.fail("the call should have failed");
  } catch (err) {
    assert.ok(!everything(err).includes(KEY), everything(err));
  }
  const thrower = async (req: HttpRequest): Promise<HttpResponse> => {
    throw new Error(`refused ${JSON.stringify(req.headers)}`);
  };
  const failing = new Client({ [KEY_OPTION]: KEY, transport: thrower, maxRetries: 0 } as ConstructorParameters<typeof Client>[0]);
  await assert.rejects(call(failing), (err: unknown) => !everything(err).includes(KEY));
});

test("P2 (keyed): obtainKey never shows a source URL's password", async () => {
  for (const transport of [
    async (): Promise<HttpResponse> => json(500, { message: "boom" }),
    async (req: HttpRequest): Promise<HttpResponse> => {
      throw new TypeError(`Failed to fetch ${req.url}`);
    },
  ]) {
    try {
      await obtainKey({ sourceUrl: `http://alice:${PW}@127.0.0.1:20180/doc`, transport, maxRetries: 0 });
      assert.fail("obtainKey should have failed");
    } catch (err) {
      assert.ok(!everything(err).includes(PW), everything(err));
    }
  }
});
