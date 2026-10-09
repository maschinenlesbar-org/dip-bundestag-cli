// The CLI's log: every diagnostic line on stderr — errors, warnings, notes — is one
// record with a timestamp, a level and a topic. Two formats, chosen with the global
// `--log-format`:
//
//   text   2026-10-09T14:03:12.481Z WARN  [dip.http] the API key is sent unencrypted …
//   jsonl  {"ts":"2026-10-09T14:03:12.481Z","level":"WARN","topic":"dip.http","msg":"…"}
//
// The text form follows log4j's pattern (`%d %-5p [%c] %m`), with the time in UTC
// ISO 8601. The topic is a dotted logger name: the program, then the area the record
// comes from (`dip.cli`, `dip.api`, `dip.http`, `dip.config`, …). stdout carries data
// only and is not touched; neither is `--help`/`--version`, nor the no-echo prompt.

import { toWellFormed } from "../client/errors.js";

/** The log formats `--log-format` takes. */
export const LOG_FORMATS = ["text", "jsonl"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

/** The format without `--log-format`. */
export const DEFAULT_LOG_FORMAT: LogFormat = "text";

export type LogLevel = "ERROR" | "WARN" | "INFO";

/** The program's name in every topic: `dip.<area>`. */
export const LOG_PROGRAM = "dip";

export interface LogRecord {
  /** ISO 8601, UTC, milliseconds. */
  ts: string;
  level: LogLevel;
  /** `<program>.<area>`, like `dip.http`. */
  topic: string;
  msg: string;
}

/** True for a character a record never carries raw (see `escapeForRecord`). */
function escapedInRecords(c: number): boolean {
  return (
    (c < 0x20 && c !== 0x09) || // C0 but TAB
    (c >= 0x7f && c <= 0x9f) || // DEL and C1 (NEL, the 8-bit CSI)
    c === 0x2028 || c === 0x2029 || // line and paragraph separator
    c === 0x061c || c === 0x200e || c === 0x200f || // bidi marks
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings and overrides
    (c >= 0x2066 && c <= 0x2069) // bidi isolates
  );
}

/**
 * `text` with every character that could split a record, forge a second one or steer
 * the terminal written as an escape: CR as `\r`, LF as `\n`, any other C0 control but
 * TAB, DEL and C1 as `\u00XX`, U+2028, U+2029 and the bidi controls (U+061C, U+200E,
 * U+200F, U+202A–U+202E, U+2066–U+2069) as `\uXXXX`. Backslashes stay as they are. On
 * the output of `JSON.stringify` (no raw C0 left) every escape it adds is valid JSON,
 * so the same helper serves both formats. Checked by char code, so the source stays
 * free of those characters.
 */
export function escapeForRecord(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!escapedInRecords(c)) continue;
    const escaped = c === 0x0d ? "\\r" : c === 0x0a ? "\\n" : "\\u" + c.toString(16).padStart(4, "0");
    out += text.slice(from, i) + escaped;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * One record as one line, whatever the message holds: `escapeForRecord` runs over the
 * message (text) or over the whole JSON object (jsonl), so no text that reaches a
 * record can split it, forge another one, or reach the terminal as a control sequence.
 */
export function formatLogRecord(record: LogRecord, format: LogFormat): string {
  // Well-formed first: half a character would be `\ud83d` in jsonl, which jq rejects,
  // stopping the whole stream.
  const msg = toWellFormed(record.msg);
  if (format === "jsonl") return escapeForRecord(JSON.stringify({ ts: record.ts, level: record.level, topic: record.topic, msg }));
  return `${record.ts} ${record.level.padEnd(5)} [${record.topic}] ${escapeForRecord(msg)}`;
}

export interface Logger {
  readonly format: LogFormat;
  error(area: string, msg: string): void;
  warn(area: string, msg: string): void;
  info(area: string, msg: string): void;
}

/** A logger that writes each record, formatted, to `write` (stderr: `CliIO.err`). */
export function createLogger(options: { format: LogFormat; write: (line: string) => void; now?: () => Date }): Logger {
  const now = options.now ?? (() => new Date());
  const log = (level: LogLevel) => (area: string, msg: string): void =>
    options.write(formatLogRecord({ ts: now().toISOString(), level, topic: `${LOG_PROGRAM}.${area}`, msg }, options.format));
  return { format: options.format, error: log("ERROR"), warn: log("WARN"), info: log("INFO") };
}

/** Why `value` is not a log format, or undefined. */
export function logFormatProblem(value: string): string | undefined {
  return (LOG_FORMATS as readonly string[]).includes(value) ? undefined : `Expected one of ${LOG_FORMATS.join(", ")}.`;
}

/**
 * The `--log-format` in `argv`, read before commander parses it: commander's own
 * usage errors are logged too, and they happen while parsing. A missing or unknown
 * value gives the default here; commander then reports an unknown one.
 */
export function logFormatFromArgv(argv: readonly string[]): LogFormat {
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token === "--log-format") format = argv[i + 1];
    else if (token.startsWith("--log-format=")) format = token.slice("--log-format=".length);
  }
  return format !== undefined && logFormatProblem(format) === undefined ? (format as LogFormat) : DEFAULT_LOG_FORMAT;
}
