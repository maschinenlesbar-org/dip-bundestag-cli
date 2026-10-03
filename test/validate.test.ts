// The library's input validation layer (src/client/validate.ts), the error class
// it throws, and how run.ts reports that class.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNonBlankParams,
  assertValid,
  isBlank,
  nonEmptyProblem,
  type Problem,
} from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { DipError, DipUsageError, DipValidationError } from "../src/client/errors.js";
import { parity, requestKey } from "./helpers.js";

const nonEmpty: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("thing", "x", nonEmpty), "x");
});

test("assertValid throws DipValidationError with `Invalid <name>: <reason>`", () => {
  assert.throws(
    () => assertValid("thing", "  ", nonEmpty),
    (e: unknown) =>
      e instanceof DipValidationError &&
      e.message === "Invalid thing: Expected a non-empty value." &&
      e.name === "DipValidationError",
  );
});

test("DipValidationError extends DipUsageError and DipError", () => {
  const e = new DipValidationError("x");
  assert.ok(e instanceof DipUsageError);
  assert.ok(e instanceof DipError);
});

test("the package root exports the validation layer and both usage classes", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.DipValidationError, DipValidationError);
  assert.equal(lib.DipUsageError, DipUsageError);
});

test("run() maps a DipValidationError from an action to exit 2 and `Error: <message>`", async () => {
  const r = await parity({
    argv: ["vorgang", "list"],
    lib: () => undefined,
    responder: () => {
      throw new DipValidationError("Invalid thing: Expected a non-empty value.");
    },
  });
  assert.equal(r.cli.code, 2);
  assert.equal(r.cli.err, "Error: Invalid thing: Expected a non-empty value.");
});

test("parity() runs the CLI and the library on one recording transport", async () => {
  const r = await parity({
    argv: ["--api-key", "k", "vorgang", "list", "--filter", "f.titel=Klima"],
    lib: (transport) => new lib.DipClient({ apiKey: "k", transport }).vorgaenge.list({ "f.titel": "Klima" }),
  });
  assert.equal(r.cli.code, 0);
  assert.ok(r.lib.ok);
  assert.equal(r.cli.requests.length, 1);
  assert.deepEqual(r.cli.requests.map(requestKey), r.lib.requests.map(requestKey));
});

// ---- Blank values (PAT-9) -------------------------------------------------------

test("isBlank is true for empty and whitespace-only strings only", () => {
  assert.equal(isBlank(""), true);
  assert.equal(isBlank(" \t\n"), true);
  assert.equal(isBlank(" x "), false);
});

test("nonEmptyProblem names a blank value", () => {
  assert.equal(nonEmptyProblem(""), "Expected a non-empty value.");
  assert.equal(nonEmptyProblem("  "), "Expected a non-empty value.");
  assert.equal(nonEmptyProblem("x"), undefined);
});

test("assertNonBlankParams rejects blank keys, values and array elements, and empty arrays", () => {
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ "f.titel": "" }, /^Invalid f\.titel: Expected a non-empty value\.$/],
    [{ cursor: "  " }, /^Invalid cursor: /],
    [{ "f.id": ["1", ""] }, /^Invalid f\.id: Expected a non-empty value\.$/],
    [{ "f.id": [] }, /^Invalid f\.id: Expected at least one value\.$/],
    [{ "": "x" }, /^Invalid query parameter name: Expected a non-empty value\.$/],
    [{ "  ": "x" }, /^Invalid query parameter name: /],
  ];
  for (const [params, message] of bad) {
    assert.throws(() => assertNonBlankParams(params as never), (e: unknown) => e instanceof DipValidationError && message.test(e.message));
  }
});

test("assertNonBlankParams accepts omitted values, numbers, dates and padded text", () => {
  assertNonBlankParams({ a: undefined, b: null, c: 0, d: new Date(0), e: " x ", f: ["1", 2], g: false });
});
