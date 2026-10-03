// CLI <-> library parity: the same input through run() and through the library
// call on one recording mock transport must give the same outcome. Either both
// reject before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient } from "../src/client/client.js";
import { DipValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import { parity, requestKey, type ParityResult } from "./helpers.js";

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
