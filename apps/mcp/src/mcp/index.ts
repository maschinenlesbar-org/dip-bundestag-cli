#!/usr/bin/env node
// Binary entry point. On stdio, stdout is the protocol: nothing else may write there, so the
// console goes to stderr. The server stops when stdin ends (a stdio client closed it; the requests
// it has read are answered first, run.ts) or on SIGINT/SIGTERM, exiting 0 or 130/143: in a
// container this process is PID 1, which ignores a signal nothing listens for.

import { format } from "node:util";
import { installWarningLog } from "@maschinenlesbar.org/dip-bundestag-log";
import { run } from "./run.js";

console.log = console.error;
console.info = console.error;
console.debug = console.error;
console.warn = console.error;

const argv = process.argv.slice(2);
const stdio = !argv.some((arg, i) => arg === "--transport=http" || (arg === "--transport" && argv[i + 1] === "http"));

let received = false;
if (stdio) process.stdin.on("data", () => (received = true));
let stop: () => void = () => {};
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
  if (stdio) process.stdin.once("end", () => resolve()).once("close", () => resolve());
});
// stdio ends at once; HTTP drains first (run.ts: calls in flight answer, up to 5 s), and a second
// signal ends it at once. The exit code is the signal's either way.
let signalCode: number | undefined;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (stdio || signalCode !== undefined) process.exit(code);
    signalCode = code;
    stop();
  });
}
// A stdio client that went away: nothing left to answer.
process.stdout.on("error", () => process.exit(0));

const code = await run(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (line) => process.stderr.write(`${line}\n`),
  stopped,
  stdinReceived: () => received,
  // Credentials, for an API that needs them (credentials.ts): from here only, never in a test.
  env: process.env,
  credentialsFile: true,
  onLogger: (log) => {
    installWarningLog(process, log, "mcp");
    // What a dependency prints is a record too: every stderr line is one.
    const toLog = (...args: unknown[]): void => log.warn("mcp", format(...args));
    console.log = console.info = console.debug = console.warn = console.error = toLog;
  },
});
process.exit(signalCode ?? code);
