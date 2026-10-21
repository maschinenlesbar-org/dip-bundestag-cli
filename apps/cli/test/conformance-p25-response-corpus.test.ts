// Conformance test P25 (trend analysis 2026-10-21; fix plan 2026-10-21, D3, D4 and D9): an
// answer is exact, or it is an error. A 2xx body whose number a double can't carry (out of range,
// past 2^53 in any written form, too small and turned into 0, or a subnormal that prints changed:
// 3e-324 became 5e-324), and an empty one, are errors on the CLI (exit 1, an ERROR record of
// <bin>.api naming the request, nothing on stdout) and in the library (the parse error, naming
// the request too), never a changed value or "nothing found". A number a double carries (or a
// decimal fraction in the normal range, as JSON means it) is printed as the same value. A member
// the repo declares as a big integer (`bigIntegerKeys`) is delivered as its exact literal, as a
// string, whatever its size. Shared across the *-cli repos; only the adapter differs.

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
/** The request an answer error names: the method and the host of the default base URL. */
const REQUEST = `GET ${new URL(DEFAULT_BASE_URL).protocol}//${new URL(DEFAULT_BASE_URL).host}/`;
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/dip-bundestag-client/internal/engine";
/**
 * The member names the repo's client declares as big integers (its `bigIntegerKeys`), usually
 * none. `bigBody(key, literal)` is a 2xx body for the call above with that member set to `literal`
 * where the client reads it; `bigFromCli`/`bigFromLib` read it back.
 */
const BIG_INTEGER_KEYS: readonly string[] = [];
const bigBody = (key: string, literal: string): string => `{"id":"1",${JSON.stringify(key)}:${literal}}`;
const bigFromCli = (out: string, key: string): unknown => (JSON.parse(out) as Record<string, unknown>)[key];
const bigFromLib = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];
// --------------------------------------------------------------------------------------

const INEXACT = [
  "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
  "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
  "123456789012345678901234567890",
  // Subnormal: a double has fewer digits below 2.2250738585072014e-308 (D4).
  "3e-324", "4e-324", "-4e-324", "1.2345678901234567e-310",
];
const EXACT: Array<[string, number]> = [
  ["0", 0], ["-0", -0], ["42", 42], ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53],
  ["9007199254740992e0", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0.1", 0.1], ["1.10", 1.1],
  ["-2.5e-3", -0.0025], ["5e-324", 5e-324], ["0.0e-500", 0],
  // A subnormal printed as written, and the smallest normal double (D4).
  ["1e-310", 1e-310], ["-5e-324", -5e-324], ["2.2250738585072014e-308", 2.2250738585072014e-308],
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
    // The error names the request, on both sides (D9).
    assert.ok(o.cli.err.includes(REQUEST), `${literal}: ${o.cli.err}`);
    assert.ok(o.lib.error?.message.startsWith(REQUEST), `${literal}: ${o.lib.error?.message}`);
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
    assert.ok(o.cli.err.includes(REQUEST) && o.lib.error?.message.startsWith(REQUEST), `${o.cli.err} | ${o.lib.error?.message}`);
  }
});

test("P25: a malformed answer names the request (method and URL) on both sides", async () => {
  for (const [raw, type] of [["<html>maintenance</html>", "text/html"], ["{", "application/json"]] as const) {
    const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(raw, type));
    assert.equal(o.cli.code, PARSE_EXIT, raw);
    assert.ok(o.cli.err.includes(REQUEST), `${raw}: ${o.cli.err}`);
    assert.ok(o.lib.error?.message.startsWith(REQUEST), `${raw}: ${o.lib.error?.message}`);
  }
});

test("P25: a declared big-integer member is its exact literal as a string; an undeclared one is refused", async () => {
  for (const key of BIG_INTEGER_KEYS) {
    for (const literal of ["1858054135406919680", "5", "-12345678901234567890", "0"]) {
      const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(bigBody(key, literal), "application/json"));
      assert.equal(o.cli.code, 0, `${key} ${literal}: ${o.cli.err}`);
      assert.equal(bigFromCli(o.cli.out, key), literal, `${key} ${literal}`);
      assert.equal(o.lib.ok, true, `${key} ${literal}`);
      assert.equal(bigFromLib(o.lib.value, key), literal, `${key} ${literal}`);
    }
  }
  // Nothing else is declared by accident: Solr's `_version_` (unless the repo declares it) is refused.
  const undeclared = ["_version_", "n"].find((key) => !BIG_INTEGER_KEYS.includes(key)) ?? "n";
  const o = await parity(argv, (t) => lib(new Client({ transport: t })), () => rawResponse(bigBody(undeclared, "1858054135406919680"), "application/json"));
  assert.equal(o.cli.code, PARSE_EXIT, o.cli.out);
  assert.equal(o.lib.ok, false);
});
