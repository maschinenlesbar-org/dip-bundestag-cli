// Conformance test P23 (2026-10-09): every diagnostic line on stderr is a log record with
// a timestamp, a level and a topic. `--log-format text` (the default) writes it log4j
// style — `2026-01-02T03:04:05.678Z WARN  [<program>.http] …` — and `--log-format jsonl`
// one JSON object per line with exactly `ts`, `level`, `topic` and `msg`. commander's own
// usage errors are records too; stdout carries data only; a secret is kept out of the log
// in either format. Shared across the *-cli repos; only the adapter block below differs
// per repo.
//
// The fix plan of the 2026-10-09 sweep (.reviews/2026-10-09-exploratory/fix-plan.md) added:
// a hostile message is one line with nothing raw, well-formed and bounded (L1-L3); a secret
// is replaced in the message only, before escaping (L4); commander's help is one record per
// line and every failure has an ERROR (L5); the format is commander's (L6); a malformed
// answer is `api` (L9); echoed credentials are replaced (L13); an `a:b@c` value that is no
// URL is left alone (L14). Adapter switches added with them: VALUE_OPTION, OUTPUT_OPTION,
// errorAnswer, MALFORMED_ANSWERS, secretArgv, and the import of MAX_RECORD_MESSAGE.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "../src/client/client.js";
import { MAX_RECORD_MESSAGE } from "../src/cli/log.js";
/** The program's name, the first part of every topic. */
const PROGRAM = "dip";
/** A command that needs no arguments and makes one request. */
const SIMPLE_COMMAND = ["vorgang", "list"];
/** A successful answer to SIMPLE_COMMAND. */
const okBody = { numFound: 0, documents: [] };
/** The exit code of a usage error. */
const USAGE_EXIT = 2;
/** The option that writes the output to a file and logs where, or undefined if the CLI has none. */
const OUTPUT_OPTION: string | undefined = "-o";
/** An option that takes a value and validates it: a rejected value is echoed in the record. */
const VALUE_OPTION = "--timeout";
/** An error answer whose ERROR record quotes `message` (as far as the repo keeps it). */
function errorAnswer(message: string): HttpResponse {
  return { status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail: message })) };
}
/**
 * argv that makes `secret` a secret of the run, which the log must replace. Keyed repos:
 * the key flag; the others: the password of a base URL (`--base-url http://u:<secret>@host`).
 */
function secretArgv(secret: string): string[] {
  return ["--api-key", secret];
}
/** Malformed answers to SIMPLE_COMMAND with status 200: not JSON, and JSON of the wrong shape. */
const MALFORMED_ANSWERS: HttpResponse[] = [
  { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("<html>not json</html>") },
  { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("[]") },
];
/** Builds the CliDeps for a run, on a transport that answers `okBody` (or `answer`) and a fixed clock. */
function makeDeps(out: string[], err: string[], now: () => Date, answer?: HttpResponse): CliDeps {
  const transport = async (): Promise<HttpResponse> => answer ?? {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
  };
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

async function cli(argv: string[], answer?: HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, makeDeps(out, err, () => new Date(TS), answer));
  return { code, out, err };
}

/** A message built to break a record: line breaks, a forged record, escapes, C1, bidi, DEL. */
const HOSTILE = `one\ntwo\r${TS} ERROR [${PROGRAM}.cli] forged\u001b[31m red\u0085nel\u2028ls\u2029ps\u202eevil\u2066iso\u007fdel\u009bcsi half\ud83d`;
/** Characters a record never carries raw: C0 but TAB, DEL, C1, the line and paragraph separators, bidi controls. */
const RAW = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** A lone surrogate: half of a character, which jq and other strict readers reject. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Every stderr chunk is one record: one line, nothing raw, well-formed, in text or (parsed) jsonl. */
function assertOneRecordEach(err: string[], format: string, context: string): void {
  assert.ok(err.length > 0, context);
  for (const line of err) {
    assert.ok(!RAW.test(line), `${context}: raw control or bidi character in ${JSON.stringify(line)}`);
    assert.ok(!LONE_SURROGATE.test(line), `${context}: lone surrogate in ${JSON.stringify(line)}`);
    if (format === "jsonl") {
      const record = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(record), ["ts", "level", "topic", "msg"], context);
      assert.ok(!LONE_SURROGATE.test(record["msg"] as string), `${context}: a \\ud800-style escape of half a character in ${line}`);
    } else {
      assert.match(line, new RegExp(`^${TS} (ERROR|WARN |INFO ) \\[${PROGRAM}\\.[a-z0-9-]+\\] `), `${context}: ${JSON.stringify(line)}`);
    }
  }
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

test("P23: a hostile message is one record, one line, with nothing raw (server text and user input)", async () => {
  for (const format of ["text", "jsonl"]) {
    const server = await cli(["--log-format", format, ...SIMPLE_COMMAND], errorAnswer(HOSTILE));
    assert.notEqual(server.code, 0);
    assertOneRecordEach(server.err, format, `${format}, server`);
    assert.equal(server.err.filter((line) => line.includes("forged")).length, 1, `${format}: ${server.err.join("\n")}`);

    const typed = await cli(["--log-format", format, VALUE_OPTION, HOSTILE, ...SIMPLE_COMMAND]);
    assert.equal(typed.code, USAGE_EXIT);
    assertOneRecordEach(typed.err, format, `${format}, typed`);
    assert.equal(typed.err.filter((line) => line.includes("forged")).length, 1, `${format}: ${typed.err.join("\n")}`);
  }
  // The text form keeps the message readable: a line break is shown as \n.
  const text = await cli([VALUE_OPTION, "a\nb", ...SIMPLE_COMMAND]);
  assert.ok(text.err.some((line) => line.includes("a\\nb")), text.err.join("\n"));
});

test("P23: server text cut to a length limit never leaves half a character", async () => {
  // One of the two splits a surrogate pair at any cut length, odd or even.
  for (const message of ["\u{1f600}".repeat(5000), "a" + "\u{1f600}".repeat(5000)]) {
    for (const format of ["text", "jsonl"]) {
      const r = await cli(["--log-format", format, ...SIMPLE_COMMAND], errorAnswer(message));
      assertOneRecordEach(r.err, format, `${format}, ${message.length} units`);
    }
  }
});

test("P23: a record's message is bounded: a long one is cut and says how much is missing", async () => {
  const long = "x".repeat(MAX_RECORD_MESSAGE * 3);
  for (const format of ["text", "jsonl"]) {
    const r = await cli(["--log-format", format, VALUE_OPTION, long, ...SIMPLE_COMMAND]);
    assert.equal(r.code, USAGE_EXIT);
    assertOneRecordEach(r.err, format, format);
    for (const line of r.err) {
      const msg = format === "jsonl" ? ((JSON.parse(line) as Record<string, unknown>)["msg"] as string) : line.slice(line.indexOf("] ") + 2);
      assert.ok(msg.length <= MAX_RECORD_MESSAGE + 40, `${format}: ${msg.length} characters`);
    }
    assert.ok(r.err.some((line) => /… \(\d+ more characters\)/.test(line)), `${format}: no cut marked`);
  }
});

test("P23: a secret is replaced in the message only: the record's frame stays intact", async () => {
  // A secret equal to a part of the frame: the year of the timestamp, a topic, a level.
  for (const secret of [TS.slice(0, 4), `${PROGRAM}.api`, "ERROR"]) {
    for (const format of ["text", "jsonl"]) {
      const r = await cli(["--log-format", format, ...secretArgv(secret), ...SIMPLE_COMMAND], errorAnswer(`rejected: ${secret}`));
      assert.notEqual(r.code, 0, `${secret} ${format}`);
      assertOneRecordEach(r.err, format, `${secret} ${format}`);
      if (format === "jsonl") {
        for (const line of r.err) assert.equal((JSON.parse(line) as Record<string, unknown>)["ts"], TS, line);
      }
    }
  }
});

test("P23: a secret with DEL, C1 or bidi characters is replaced before the record is escaped", async () => {
  for (const secret of ["my key\u007fx-Secret1", "my key\u0085x-Secret2", "my key\u202ex-Secret3"]) {
    for (const format of ["text", "jsonl"]) {
      const r = await cli(["--log-format", format, ...secretArgv(secret), ...SIMPLE_COMMAND]);
      const all = r.err.join("\n");
      assert.ok(!/Secret\d/.test(all), `${format}: ${JSON.stringify(secret)} printed:\n${all}`);
    }
  }
});

test("P23: credentials a server echoes back are replaced in the record (Basic, user:password, password)", async () => {
  const basic = `Basic ${Buffer.from("alice:s3cret-pw", "latin1").toString("base64")}`;
  const echo = `denied: Authorization: ${basic}; user alice:s3cret-pw; password s3cret-pw`;
  for (const format of ["text", "jsonl"]) {
    const r = await cli(["--log-format", format, "--base-url", "https://alice:s3cret-pw@mirror.example", ...SIMPLE_COMMAND], errorAnswer(echo));
    const all = r.err.join("\n");
    assert.ok(all.includes("denied"), `${format}: the message is there:\n${all}`);
    for (const form of [basic.slice("Basic ".length), "alice:s3cret-pw", "s3cret-pw"]) {
      assert.ok(!all.includes(form), `${format}: ${form} printed:\n${all}`);
    }
  }
});

test("P23: a value shaped like a:b@c that is no URL is not taken for a credential", async () => {
  const typed = await cli([VALUE_OPTION, "run:2026-10-09@x", ...SIMPLE_COMMAND]);
  assert.equal(typed.code, USAGE_EXIT);
  assert.ok(typed.err.some((line) => line.includes("run:2026-10-09@x")), typed.err.join("\n"));
  if (OUTPUT_OPTION !== undefined) {
    const written = await cli([OUTPUT_OPTION, "run:2026-10-09@x.json", ...SIMPLE_COMMAND]);
    assert.equal(written.code, 0, written.err.join("\n"));
    assert.ok(written.err.some((line) => line.includes("run:2026-10-09@x.json")), written.err.join("\n"));
  }
});

test("P23: commander's help after an error is one record per line, its suggestion part of the error", async () => {
  for (const format of ["text", "jsonl"]) {
    const r = await cli(["--log-format", format, ...SIMPLE_COMMAND, "--no-such-option"]);
    assert.equal(r.code, USAGE_EXIT);
    assertOneRecordEach(r.err, format, format);
    const msgs = r.err.map((line) => (format === "jsonl" ? ((JSON.parse(line) as Record<string, unknown>)["msg"] as string) : line.slice(line.indexOf("] ") + 2)));
    assert.ok(msgs.length > 2, `${format}: the help is several records:\n${r.err.join("\n")}`);
    assert.ok(msgs.every((msg) => !msg.includes("\\n") && !msg.includes("\n") && msg.trim() !== ""), `${format}:\n${r.err.join("\n")}`);
    assert.ok(msgs.some((msg) => /^Usage: /.test(msg)), `${format}:\n${r.err.join("\n")}`);

    const typo = await cli(["--log-format", format, `${SIMPLE_COMMAND[0]}x`]);
    assert.equal(typo.code, USAGE_EXIT);
    const first = format === "jsonl" ? ((JSON.parse(typo.err[0] as string) as Record<string, unknown>)["msg"] as string) : (typo.err[0] as string);
    assert.match(first, new RegExp(`unknown command '${SIMPLE_COMMAND[0]}x' \\(Did you mean ${SIMPLE_COMMAND[0]}\\?\\)`), typo.err.join("\n"));
  }
});

test("P23: every failed run has an ERROR record, a missing command included", async () => {
  for (const argv of [[], [SIMPLE_COMMAND[0] as string]]) {
    const r = await cli(argv);
    if (r.code === 0) continue; // a command that runs on its own
    assert.match(r.err[0] ?? "", new RegExp(`^${TS} ERROR \\[${PROGRAM}\\.cli\\] missing command: \``), `${JSON.stringify(argv)}:\n${r.err.join("\n")}`);
    assertOneRecordEach(r.err, "text", JSON.stringify(argv));
  }
});

test("P23: the log format is the one commander parsed, also where an option's value looks like --log-format", async () => {
  // commander takes "--log-format=jsonl" as the User-Agent: the log stays text.
  const ua = await cli(["--user-agent", "--log-format=jsonl", ...SIMPLE_COMMAND], errorAnswer("boom"));
  assert.notEqual(ua.code, 0);
  assertOneRecordEach(ua.err, "text", "--user-agent --log-format=jsonl");
  // commander takes "--" as the User-Agent and then parses --log-format jsonl.
  const dashes = await cli(["--user-agent", "--", "--log-format", "jsonl", ...SIMPLE_COMMAND], errorAnswer("boom"));
  assert.notEqual(dashes.code, 0);
  assertOneRecordEach(dashes.err, "jsonl", "--user-agent -- --log-format jsonl");
});

test("P23: a malformed answer is an ERROR record of <program>.api", async () => {
  for (const answer of MALFORMED_ANSWERS) {
    const r = await cli(SIMPLE_COMMAND, answer);
    assert.notEqual(r.code, 0, answer.body.toString());
    assert.match(r.err[0] ?? "", new RegExp(`^${TS} ERROR \\[${PROGRAM}\\.api\\] `), r.err.join("\n"));
  }
});
