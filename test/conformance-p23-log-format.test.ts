// Conformance test P23 (2026-10-09): every diagnostic line on stderr is a log record with
// a timestamp, a level and a topic. `--log-format text` (the default) writes it log4j
// style — `2026-01-02T03:04:05.678Z WARN  [<program>.http] …` — and `--log-format jsonl`
// one JSON object per line with exactly `ts`, `level`, `topic` and `msg`. commander's own
// usage errors are records too; stdout carries data only; a secret is kept out of the log
// in either format. Shared across the *-cli repos; only the adapter block below differs
// per repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "../src/client/client.js";
/** The program's name, the first part of every topic. */
const PROGRAM = "dip";
/** A command that needs no arguments and makes one request. */
const SIMPLE_COMMAND = ["vorgang", "list"];
/** A successful answer to SIMPLE_COMMAND. */
const okBody = { numFound: 0, documents: [] };
/** The exit code of a usage error. */
const USAGE_EXIT = 2;
/** Builds the CliDeps for a run, on a transport that answers `okBody` and a fixed clock. */
function makeDeps(out: string[], err: string[], now: () => Date): CliDeps {
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
  });
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), writeFile: () => {}, outBinary: () => {} },
    env: {},
    now,
    createClient: (opts) => new Client({ ...opts, transport }),
  };
}
// --------------------------------------------------------------------------------------

const TS = "2026-01-02T03:04:05.678Z";
const TOPIC = new RegExp(`^${PROGRAM}\\.[a-z0-9-]+$`);

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, makeDeps(out, err, () => new Date(TS)));
  return { code, out, err };
}

test("P23: a usage error is a log4j-style ERROR record by default", async () => {
  const r = await cli([...SIMPLE_COMMAND, "--no-such-option"]);
  assert.equal(r.code, USAGE_EXIT);
  assert.match(r.err[0] ?? "", new RegExp(`^${TS} ERROR \\[${PROGRAM}\\.cli\\] unknown option '--no-such-option'`));
  assert.deepEqual(r.out, []);
});

test("P23: --log-format jsonl writes one JSON object per line: ts, level, topic, msg", async () => {
  for (const flag of [["--log-format", "jsonl"], ["--log-format=jsonl"]]) {
    const r = await cli([...flag, ...SIMPLE_COMMAND, "--no-such-option"]);
    assert.equal(r.code, USAGE_EXIT, flag.join(" "));
    assert.ok(r.err.length > 0, flag.join(" "));
    for (const line of r.err.flatMap((chunk) => chunk.split("\n"))) {
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(record), ["ts", "level", "topic", "msg"], line);
      assert.equal(record["ts"], TS);
      assert.ok(["ERROR", "WARN", "INFO"].includes(record["level"] as string), line);
      assert.match(record["topic"] as string, TOPIC);
    }
    const first = JSON.parse(r.err[0] as string) as Record<string, unknown>;
    assert.deepEqual([first["level"], first["topic"]], ["ERROR", `${PROGRAM}.cli`]);
    assert.match(first["msg"] as string, /unknown option '--no-such-option'/);
  }
});

test("P23: a warning is a WARN record of <program>.http, and stdout keeps the data", async () => {
  const text = await cli(["--base-url", "http://mirror.example", ...SIMPLE_COMMAND]);
  assert.equal(text.code, 0, text.err.join("\n"));
  assert.ok(text.err.some((line) => line.startsWith(`${TS} WARN  [${PROGRAM}.http] `)), text.err.join("\n"));
  assert.ok(text.out.length > 0 && text.out.every((line) => !line.startsWith(TS)), "no log record on stdout");

  const jsonl = await cli(["--log-format", "jsonl", "--base-url", "http://mirror.example", ...SIMPLE_COMMAND]);
  assert.equal(jsonl.code, 0, jsonl.err.join("\n"));
  const records = jsonl.err.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(records.some((record) => record["level"] === "WARN" && record["topic"] === `${PROGRAM}.http`), jsonl.err.join("\n"));
  assert.deepEqual(jsonl.out, text.out, "the log format does not change stdout");
});

test("P23: an unknown --log-format is a usage error, in the text format", async () => {
  const r = await cli(["--log-format", "xml", ...SIMPLE_COMMAND]);
  assert.equal(r.code, USAGE_EXIT);
  assert.match(r.err[0] ?? "", new RegExp(`^${TS} ERROR \\[${PROGRAM}\\.cli\\] .*Expected one of text, jsonl`));
});

test("P23: a secret is kept out of the log in either format", async () => {
  for (const format of ["text", "jsonl"]) {
    const r = await cli(["--log-format", format, "--base-url", "http://alice:s3cr3t-pw@mirror.example", ...SIMPLE_COMMAND]);
    assert.ok(!r.err.join("\n").includes("s3cr3t-pw"), `${format}: ${r.err.join("\n")}`);
  }
});
