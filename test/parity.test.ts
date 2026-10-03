// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome. Either both
// reject before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient } from "../src/client/client.js";
import { DipValidationError } from "../src/client/errors.js";
import { MAX_TIMEOUT_MS, type Transport } from "../src/client/http.js";
import { MAX_REDIRECTS, MAX_RETRIES, RequestEngine } from "../src/client/engine.js";
import { obtainKey } from "../src/client/obtain-key.js";
import { jsonResponse, parity, requestKey, type ParityResult } from "./helpers.js";

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
