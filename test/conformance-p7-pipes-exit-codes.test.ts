// Conformance test P7 (fix plan 2026-10-06): a closed pipe never turns into a stack trace or
// a wrong exit code. A large output into a reader that stops early exits 0 quietly; a failed
// run whose stderr reader has gone away keeps its exit code. Runs the built bin in a child
// process — pipes can't be checked in-process. Shared across repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/** argv for a usage error, and its exit code. */
const USAGE = { argv: ["--no-such-option"], exit: 2 };
/** argv that prints the server's big answer, given the mock's base URL. */
const bigOutputArgv = (base: string): string[] => ["--base-url", base, "vorgang", "list"];
/** A large answer for that command (≈ 1 MB of JSON). */
const bigBody = (): unknown => ({
  numFound: 20000,
  documents: Array.from({ length: 20000 }, (_, i) => ({ id: String(i), titel: `Vorgang ${i}` })),
});
/** argv for a network failure, and its exit code. */
const NETWORK = { argv: ["--base-url", "http://127.0.0.1:9", "--max-retries", "0", "vorgang", "list"], exit: 1 };
// --------------------------------------------------------------------------------------

interface Outcome { code: number | null; stderr: string }

function runBin(argv: string[], opts: { closeStdoutAfter?: number; closeStderr?: boolean }): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let seen = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (opts.closeStdoutAfter !== undefined && seen >= opts.closeStdoutAfter) child.stdout.destroy();
    });
    if (opts.closeStderr) child.stderr.destroy();
    else child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("P7: a large output into a reader that stops early exits 0 without a stack trace", async () => {
  const body = JSON.stringify(bigBody());
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outcome = await runBin(bigOutputArgv(base), { closeStdoutAfter: 100 });
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.doesNotMatch(outcome.stderr, /EPIPE|at .*\(node:|Error:/, outcome.stderr);
  } finally {
    server.close();
  }
});

test("P7: a failed run keeps its exit code when stderr's reader is gone", async () => {
  for (const { argv, exit } of [USAGE, NETWORK]) {
    const outcome = await runBin(argv, { closeStderr: true });
    assert.equal(outcome.code, exit, `argv ${argv.join(" ")}`);
  }
});
