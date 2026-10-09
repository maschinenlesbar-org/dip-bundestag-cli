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

import { escapeControlChars } from "./shared.js";

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

/** One record as one line (text: the message's own line breaks stay; jsonl: one line always). */
export function formatLogRecord(record: LogRecord, format: LogFormat): string {
  if (format === "jsonl") return escapeControlChars(JSON.stringify({ ts: record.ts, level: record.level, topic: record.topic, msg: record.msg }));
  return `${record.ts} ${record.level.padEnd(5)} [${record.topic}] ${record.msg}`;
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
