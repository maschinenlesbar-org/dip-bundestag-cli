// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never goes out.
// An unknown, misspelled or `__proto__` key, an unknown filter name, an array or NaN where
// the API takes one value are the library's validation error before any data request; a
// filter name that is only spelled differently (NFD, padding, case) is normalised or
// rejected, never sent as typed; a repeated filter flag is combined or rejected, never
// "last one wins". The API answers all of these with the whole unfiltered set or a wrong
// count and HTTP 200. Shared across the *-cli repos with filters; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import { DipValidationError as ValidationError } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";

// ---- adapter (per repo) -------------------------------------------------------------
/** The library's filtered call, with its query/parameter object passed through as is. */
const call = (client: Client, query: Record<string, unknown>): Promise<unknown> =>
  client.vorgaenge.list(query as never);
/**
 * A valid query, and the filter it sends (read back from the request by `sentFilter`). DIP
 * takes a repeated key as an OR set, so an array is a valid value here.
 */
const GOOD = { query: { "f.titel": ["Klima", "Gesetz"], "f.wahlperiode": 20 } };
const GOOD_SENT = "f.titel=Klima&f.titel=Gesetz&f.wahlperiode=20";
/** What a data request carries as its filters: every parameter but the cursor. */
const sentFilter = (req: HttpRequest): string | null => {
  const pairs = [...new URL(req.url).searchParams].filter(([k]) => k !== "cursor");
  return pairs.length === 0 ? null : pairs.map(([k, v]) => `${k}=${v}`).join("&");
};
/** Queries with a key the call doesn't take: unknown, misspelled, `__proto__` (from JSON). */
const BAD_KEYS: Array<[string, Record<string, unknown>]> = [
  ["unknown key", { "f.nope": "x" }],
  ["misspelled key", { "f.titl": "Klima" }],
  ["wrong-case key", { "F.titel": "Klima" }],
  ["filter of another resource", { "f.person": "Merkel" }],
  ["__proto__ key", JSON.parse('{"__proto__": {"f.titel": "Klima"}}') as Record<string, unknown>],
];
/** Filter names the API doesn't have: DIP's names all start with `f.`; the JavaScript names never reach it. */
const BAD_FILTER_NAMES: Array<[string, Record<string, unknown>]> = [
  ["constructor name", { constructor: "x" }],
  ["prototype name", { prototype: "x" }],
  ["toString name", { toString: "x" }],
];
/**
 * Values of the wrong type. An array is no case here: DIP takes a repeated key as an OR set,
 * so `{ "f.titel": ["a", "b"] }` is valid (GOOD); its blank element is not.
 */
const BAD_VALUES: Array<[string, Record<string, unknown>]> = [
  ["array with a blank element", { "f.titel": ["Klima", ""] }],
  ["empty array", { "f.titel": [] }],
  ["blank value", { "f.titel": "  " }],
  ["non-integer id", { "f.id": "12a" }],
  ["negative Wahlperiode", { "f.wahlperiode": -20 }],
  ["NaN Wahlperiode", { "f.wahlperiode": Number.NaN }],
];
/**
 * Filter keys that differ from GOOD only in how they are spelled (padding, decomposed
 * characters): DIP would ignore them. Its filter names are ASCII, so such a key is rejected.
 */
const UNNORMALISED: Array<[string, Record<string, unknown>]> = [
  ["padded key", { " f.titel": ["Klima", "Gesetz"], "f.wahlperiode": 20 }],
  ["trailing space in key", { "f.titel ": ["Klima", "Gesetz"], "f.wahlperiode": 20 }],
  ["NFD letter in key", { "f.tite\u0301l": ["Klima", "Gesetz"], "f.wahlperiode": 20 }],
];
const UNNORMALISED_POLICY = "reject" as "normalise" | "reject";
/** The CLI's filter given twice (same key), and what the repo does with it: DIP's OR set. */
const REPEATED_FLAG_ARGV = ["vorgang", "list", "--filter", "f.titel=Klima", "--filter", "f.titel=Gesetz", "--filter", "f.wahlperiode=20"];
const REPEATED_POLICY = "combine" as "combine" | "reject";
/** A single-value option given twice, which must be a usage error. */
const REPEATED_SINGLE_ARGV = ["--base-url", "https://a.test", "--base-url", "https://b.test", "vorgang", "list", "--filter", "f.wahlperiode=20"];
const USAGE_EXIT = 2;
/** Every request the client sends fetches data. */
const isDataRequest = (_req: HttpRequest): boolean => true;
/** The answer to any request. */
const respond = (_req: HttpRequest): HttpResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ numFound: 0, documents: [], cursor: "*" })),
});
/** CliDeps for this repo. */
const makeDeps = (io: Pick<CliDeps["io"], "out" | "err">, transport: (req: HttpRequest) => Promise<HttpResponse>): CliDeps => ({
  io: { ...io, writeFile: () => assert.fail("no file"), outBinary: () => assert.fail("no binary") },
  env: { DIP_API_KEY: "TestKey.testtesttesttesttesttesttesttestte" },
  createClient: (opts) => new Client({ ...opts, transport }),
});
// --------------------------------------------------------------------------------------

function recorder() {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    return respond(req);
  };
  return { transport, data: () => requests.filter(isDataRequest) };
}

async function rejectsBeforeData(label: string, query: Record<string, unknown>): Promise<void> {
  const r = recorder();
  await assert.rejects(call(new Client({ transport: r.transport }), query), ValidationError, label);
  assert.equal(r.data().length, 0, `${label}: a data request went out`);
}

test("P10: the valid query goes out as given", async () => {
  const r = recorder();
  await call(new Client({ transport: r.transport }), GOOD.query);
  assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
});

test("P10: an unknown, misspelled or __proto__ key is a validation error before any data request", async () => {
  for (const [label, query] of BAD_KEYS) await rejectsBeforeData(label, query);
});

test("P10: a filter name the API doesn't have is a validation error before any data request", async () => {
  for (const [label, query] of BAD_FILTER_NAMES) await rejectsBeforeData(label, query);
});

test("P10: an array, object or NaN where the API takes one value is a validation error", async () => {
  for (const [label, query] of BAD_VALUES) await rejectsBeforeData(label, query);
});

test("P10: a filter name spelled differently is normalised or rejected, never sent as typed", async () => {
  for (const [label, query] of UNNORMALISED) {
    if (UNNORMALISED_POLICY === "reject") {
      await rejectsBeforeData(label, query);
      continue;
    }
    const r = recorder();
    await call(new Client({ transport: r.transport }), query);
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT], label);
  }
});

test("P10: a repeated filter flag is combined or rejected, never last-one-wins", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_FLAG_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  if (REPEATED_POLICY === "combine") {
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(r.data().map(sentFilter), [GOOD_SENT]);
  } else {
    assert.equal(code, USAGE_EXIT);
    assert.equal(r.data().length, 0);
  }
});

test("P10: a repeated single-value option is a usage error", async () => {
  const r = recorder();
  const err: string[] = [];
  const code = await run(REPEATED_SINGLE_ARGV, makeDeps({ out: () => {}, err: (s) => err.push(s) }, r.transport));
  assert.equal(code, USAGE_EXIT, err.join("\n"));
  assert.equal(r.data().length, 0);
});
