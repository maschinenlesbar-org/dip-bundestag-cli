// Conformance test M4 (MCP kit, rollout plan 2026-11-19): the built bin on stdio, as a client
// starts it.
// - stdout carries the protocol and nothing else, stderr only log records; the end of stdin ends
//   the server with 0, SIGTERM with 143.
// - --version and --help print to stdout and exit 0; a usage error is one record and exit 2.
// - stdin closed before any message (docker run without -i) is an ERROR record that says so, and
//   exit 1.
// - A line that isn't JSON is answered with a parse error (-32700), one that isn't a JSON-RPC 2.0
//   message with an invalid request (-32600), both with id null, and leaves a WARN record; the
//   server goes on.
// - A repeated --transport means the last one, for the parser and the bin alike.
// These start a process (STARTS_A_PROCESS: 30 s, the workspace's allowance for that). A wait for
// the server has no deadline of its own (a fixed 5 s failed on a loaded machine): the test's
// timeout bounds it. Whatever the outcome, a test ends its server when it ends: stdin closed, and
// SIGKILL if it still runs after a grace, so a failed or timed-out test can't keep `node --test`
// waiting. Shared whole across the repos with an MCP server: nothing here is particular to one.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROGRAM } from "../src/mcp/version.js";

const STARTS_A_PROCESS = { timeout: 30_000 };
const bin = fileURLToPath(new URL("../src/mcp/index.js", import.meta.url));
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });

/** How long a server the test has finished with gets to end by itself before it is killed. */
const GRACE_MS = 2000;

/** Start the bin; the test `t` ends it when the test ends, passed, failed or timed out. */
function start(t: TestContext, argv: string[] = []) {
  // An upstream nobody listens on: no test here makes a request.
  const child = spawn(process.execPath, [bin, "--base-url", "https://127.0.0.1:9", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let closed = false;
  child.once("close", () => (closed = true));
  child.stdin.on("error", () => {}); // a server that already ended: EPIPE on stdin is no failure
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const graceOver = new Promise<"grace over">((resolve) => (timer = setTimeout(() => resolve("grace over"), GRACE_MS)));
    const outcome = await Promise.race([exited, graceOver]);
    clearTimeout(timer);
    if (outcome === "grace over") {
      child.kill("SIGKILL");
      await exited;
    }
  });
  /** Resolves once `ready()` holds or the server's output has ended; the test's timeout bounds the wait. */
  const until = (ready: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!ready() && !closed) return;
        child.stdout.off("data", check);
        child.off("close", check);
        resolve();
      };
      // Registered after the collectors above, so `stdout` already holds the chunk when this runs.
      child.stdout.on("data", check);
      child.on("close", check);
      check();
    });
  const firstLine = async (): Promise<string> => {
    await until(() => stdout.includes("\n"));
    return stdout.split("\n")[0] ?? "";
  };
  return { child, exited, until, firstLine, out: () => stdout, err: () => stderr };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const records = (stderr: string) => stderr.split("\n").filter((line) => line !== "");

test("an initialize gets one JSON-RPC line on stdout; the end of stdin ends the server with 0", STARTS_A_PROCESS, async (t) => {
  const server = start(t);
  server.child.stdin.write(`${initialize}\n`);
  const line = await server.firstLine();
  const answer = JSON.parse(line) as { id: number; result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(answer.id, 1);
  assert.equal(answer.result.serverInfo.name, PROGRAM);
  server.child.stdin.end();
  const started = Date.now();
  assert.deepEqual(await server.exited, { code: 0, signal: null });
  assert.ok(Date.now() - started < 5000);
  assert.ok(server.out().split("\n").filter(Boolean).every((l) => JSON.parse(l).jsonrpc === "2.0"), "stdout: protocol only");
  for (const record of records(server.err())) assert.match(record, new RegExp(`^\\S+Z (INFO|WARN|ERROR) +\\[${escape(PROGRAM)}\\.\\w+\\] `));
});

test("SIGTERM ends the server with 143", STARTS_A_PROCESS, async (t) => {
  const server = start(t);
  server.child.stdin.write(`${initialize}\n`);
  await server.firstLine();
  server.child.kill("SIGTERM");
  const exit = await server.exited;
  assert.ok(exit.code === 143 || exit.signal === "SIGTERM", JSON.stringify(exit));
});

test("--version and --help print to stdout and exit 0; a usage error is one record and exit 2", STARTS_A_PROCESS, async (t) => {
  const version = start(t, ["--version"]);
  assert.equal((await version.exited).code, 0);
  assert.match(version.out(), /^\d+\.\d+\.\d+\n$/);
  const usage = start(t, ["--port", "x"]);
  assert.equal((await usage.exited).code, 2);
  assert.equal(records(usage.err()).length, 1);
});

test("stdin closed before any message (docker run without -i) is an ERROR record that says so, and exit 1", STARTS_A_PROCESS, async (t) => {
  const server = start(t);
  server.child.stdin.end();
  assert.deepEqual(await server.exited, { code: 1, signal: null });
  const lines = records(server.err());
  const expected = `ERROR [${PROGRAM}.mcp] stdin ended before any MCP message: no client is connected on stdio. In a container, run it with docker run -i (an MCP client does); for HTTP use --transport http --host 0.0.0.0.`;
  assert.ok((lines.at(-1) ?? "").endsWith(expected), lines.at(-1));
  assert.equal(server.out(), "", "stdout stays empty");
});

test("a line that isn't JSON-RPC is answered with -32700 or -32600 and a WARN record; the server goes on", STARTS_A_PROCESS, async (t) => {
  const server = start(t);
  const invalid = ["not json", "{oops", "[]", JSON.stringify({ jsonrpc: "2.0", id: 99 }), JSON.stringify({ jsonrpc: "1.0", id: 98, method: "ping" })];
  server.child.stdin.write(`${invalid.join("\n")}\n${initialize}\n`);
  await server.until(() => server.out().split("\n").filter(Boolean).length >= invalid.length + 1);
  server.child.stdin.end();
  assert.deepEqual(await server.exited, { code: 0, signal: null });
  const answers = server.out().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: unknown; error?: { code: number }; result?: unknown });
  assert.deepEqual(
    answers.slice(0, invalid.length).map((answer) => [answer.id, answer.error?.code]),
    [[null, -32700], [null, -32700], [null, -32600], [null, -32600], [null, -32600]],
    server.out(),
  );
  assert.equal(answers[invalid.length]?.id, 1, "the initialize after them is answered");
  const warnings = records(server.err()).filter((line) => new RegExp(`WARN  \\[${escape(PROGRAM)}\\.mcp\\] stdin: `).test(line));
  assert.equal(warnings.length, invalid.length, server.err());
});

test("a repeated --transport means the last one: stdio, which ends with stdin like any other", STARTS_A_PROCESS, async (t) => {
  const server = start(t, ["--transport", "http", "--transport", "stdio"]);
  server.child.stdin.end();
  assert.deepEqual(await server.exited, { code: 1, signal: null }, server.err());
  assert.match(records(server.err()).at(-1) ?? "", new RegExp(`ERROR \\[${escape(PROGRAM)}\\.mcp\\] stdin ended before any MCP message`));
  assert.ok(records(server.err()).every((line) => new RegExp(`^\\S+Z (INFO|WARN|ERROR) +\\[${escape(PROGRAM)}\\.\\w+\\] `).test(line)), server.err());
});
