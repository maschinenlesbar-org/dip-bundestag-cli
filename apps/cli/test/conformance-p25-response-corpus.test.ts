// Conformance test P25 (trend analysis 2026-10-21): an answer is exact, or it is an error. A
// 2xx body whose number a double can't carry (out of range, past 2^53 in any written form, or
// too small and turned into 0), and an empty one, are errors on the CLI (exit 1, an ERROR record
// of <bin>.api, nothing on stdout) and in the library (the parse error), never a changed value
// or "nothing found". A number a double carries (or a decimal fraction below 2^53, as JSON means
// it) is printed as the same value. Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---- adapter (per repo) -------------------------------------------------------------
/** `parity` as in P24 (dip's `kitParity`, its own `parity` in that shape); `rawResponse(body, contentType)`. */
import { kitParity as parity, rawResponse } from "./helpers.js";
import { DipClient as Client } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
/** CLI argv for a call whose answer carries a number, and the same call in the library. */
const argv = ["--compact", "vorgang", "get", "1"];
const lib = (client: Client): Promise<unknown> => client.vorgaenge.get("1");
/** The raw 2xx body with `literal` as that number, written as is. */
const body = (literal: string): string => `{"id":"1","n":${literal}}`;
/** The number from the CLI's printed result and from the library's. */
const fromCli = (out: string): unknown => (JSON.parse(out) as { n: unknown }).n;
const fromLib = (value: unknown): unknown => (value as { n: unknown }).n;
/** The log program, as in `ERROR [<bin>.api]`. */
const BIN = "dip";
/** The exit code of a malformed answer in this repo (most repos use 1). */
const PARSE_EXIT = 1;
// --------------------------------------------------------------------------------------

const INEXACT = [
  "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
  "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
  "123456789012345678901234567890",
];
const EXACT: Array<[string, number]> = [
  ["0", 0], ["-0", -0], ["42", 42], ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53],
  ["9007199254740992e0", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0.1", 0.1], ["1.10", 1.1],
  ["-2.5e-3", -0.0025], ["5e-324", 5e-324], ["0.0e-500", 0],
  // A double printed in its shortest form (an ArcGIS sentinel, a Java Double): the same number back.
  ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
];

test("P25: a number the answer can't carry exactly is an error, never a changed value", async () => {
  for (const literal of INEXACT) {
    const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(body(literal), "application/json"));
    assert.equal(o.cli.code, PARSE_EXIT, `${literal}: CLI exit ${o.cli.code}, out ${o.cli.out}`);
    assert.equal(o.cli.out, "", literal);
    assert.match(o.cli.err, new RegExp(`^ERROR \\[${BIN}\\.api\\] .*the number ${literal.replace(/[.+]/g, "\\$&")} cannot be represented exactly`), literal);
    assert.equal(o.lib.ok, false, `${literal}: the library resolved`);
    assert.match(o.lib.error?.name ?? "", /ParseError$/, literal);
  }
});

test("P25: a number a double carries is printed as the same value", async () => {
  for (const [literal, value] of EXACT) {
    const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(body(literal), "application/json"));
    assert.equal(o.cli.code, 0, `${literal}: ${o.cli.err}`);
    assert.equal(fromCli(o.cli.out), Object.is(value, -0) ? 0 : value, literal);
    assert.equal(o.lib.ok, true, literal);
    assert.equal(fromLib(o.lib.value), value, literal);
  }
});

test("P25: an empty answer is an error, never 'nothing found'", async () => {
  for (const raw of ["", "  \n\t"]) {
    const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(raw, "application/json"));
    assert.equal(o.cli.code, PARSE_EXIT, JSON.stringify(raw));
    assert.equal(o.cli.out, "", JSON.stringify(raw));
    assert.match(o.cli.err, new RegExp(`^ERROR \\[${BIN}\\.api\\] `), JSON.stringify(raw));
    assert.equal(o.lib.ok, false, JSON.stringify(raw));
  }
});
