// The log record helpers of src/cli/log.ts, on their own. The CLI-level checks are the
// shared conformance test P23.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MAX_RECORD_MESSAGE, createLogger, escapeForRecord, formatLogRecord, installWarningLog } from "../src/cli/log.js";

const TS = "2026-01-02T03:04:05.678Z";

test("escapeForRecord: CR and LF as \\r and \\n, other C0 but TAB, DEL and C1 as \\u00XX", () => {
  assert.equal(escapeForRecord("a\r\nb"), "a\\r\\nb");
  assert.equal(escapeForRecord("tab\there"), "tab\there");
  assert.equal(escapeForRecord("esc\u001b[31m nul\u0000 del\u007f nel\u0085 csi\u009b"), "esc\\u001b[31m nul\\u0000 del\\u007f nel\\u0085 csi\\u009b");
});

test("escapeForRecord: the line and paragraph separators and the bidi controls as \\uXXXX", () => {
  assert.equal(
    escapeForRecord("\u2028\u2029\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"),
    "\\u2028\\u2029\\u061c\\u200e\\u200f\\u202a\\u202b\\u202c\\u202d\\u202e\\u2066\\u2067\\u2068\\u2069",
  );
});

test("escapeForRecord: everything else, backslashes included, stays as it is", () => {
  for (const text of ["plain", "C:\\path\\n", "Grüße 😀 €", "a\\u001b"]) assert.equal(escapeForRecord(text), text);
});

test("formatLogRecord: one line in either format, and jsonl parses back to the message", () => {
  const msg = "one\ntwo\r\u001b[31m\u2028\u202e\u007f\u0085";
  const text = formatLogRecord({ ts: TS, level: "ERROR", topic: "dip.api", msg }, "text");
  assert.equal(text, `${TS} ERROR [dip.api] one\\ntwo\\r\\u001b[31m\\u2028\\u202e\\u007f\\u0085`);
  const jsonl = formatLogRecord({ ts: TS, level: "WARN", topic: "dip.http", msg }, "jsonl");
  assert.doesNotMatch(jsonl, /[\u0000-\u001f\u007f-\u009f\u2028\u202e]/);
  assert.deepEqual(JSON.parse(jsonl), { ts: TS, level: "WARN", topic: "dip.http", msg });
});

test("formatLogRecord: a message over MAX_RECORD_MESSAGE is cut at a code point and says how much is missing", () => {
  const msg = "a" + "\u{1f600}".repeat(MAX_RECORD_MESSAGE);
  const line = formatLogRecord({ ts: TS, level: "INFO", topic: "dip.cli", msg }, "text");
  const kept = line.slice(line.indexOf("] ") + 2);
  assert.match(kept, /… \(2001 more characters\)$/);
  assert.ok(kept.length <= MAX_RECORD_MESSAGE + 30, `${kept.length}`);
  assert.doesNotMatch(kept, /�/, "no half character at the cut");
  const short = "b".repeat(MAX_RECORD_MESSAGE);
  assert.equal(formatLogRecord({ ts: TS, level: "INFO", topic: "dip.cli", msg: short }, "text"), `${TS} INFO  [dip.cli] ${short}`);
});

test("installWarningLog: Node's process warnings become WARN records of dip.cli, Node's own line removed (L10)", () => {
  const target = new EventEmitter();
  const nodeOwn: string[] = [];
  target.on("warning", (w: Error) => nodeOwn.push(w.message));
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date(TS) });
  installWarningLog(target, log);
  const warning = new Error("Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections insecure.\nsecond line");
  warning.name = "Warning";
  target.emit("warning", warning);
  assert.deepEqual(nodeOwn, [], "Node's default listener is gone");
  assert.equal(records.length, 1);
  assert.deepEqual(JSON.parse(records[0] as string), {
    ts: TS,
    level: "WARN",
    topic: "dip.cli",
    msg: `(node) Warning: ${warning.message}`,
  });
});
