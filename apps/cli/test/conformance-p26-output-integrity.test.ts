// Conformance test P26 (trend analysis 2026-10-21): `-o` never loses a file. A write cut short
// (a full disk, a quota; here a file-size limit) leaves the old file as it was and no
// half-written file or temporary file behind, and says so (exit 1, an ERROR record of
// <bin>.output). An existing file without --force is refused before any request. Runs the built
// bin in a child process under `ulimit -f`. Shared across the *-cli repos that have -o; only
// the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// ---- adapter (per repo) -------------------------------------------------------------
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/**
 * argv that writes the server's answer to `file`, given the mock's base URL. A test key is
 * passed, so the child never looks for a key in the user's credentials file.
 */
const outputArgv = (base: string, file: string, force: boolean): string[] => [
  "--base-url", base, "--api-key", "p26-test-key", "--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "vorgang", "list",
];
/** argv that prints the server's answer to stdout, given the mock's base URL. */
const stdoutArgv = (base: string): string[] => ["--base-url", base, "--api-key", "p26-test-key", "--max-retries", "0", "vorgang", "list"];
/** An answer of about 200 kB for that command, as the server sends it (any format the API speaks). */
const bigAnswer = (): { body: string; contentType: string } => ({
  body: JSON.stringify({ numFound: 10000, documents: Array.from({ length: 10000 }, (_, i) => ({ id: `${i}` })) }),
  contentType: "application/json",
});
/** The log program, as in `ERROR [<bin>.output]`. */
const PROGRAM = "dip";
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
// --------------------------------------------------------------------------------------

// These tests start the built CLI as a process: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

/**
 * Run the bin with files limited to a few kB; SIGXFSZ ignored, so a write fails with EFBIG.
 * Node passes NODE_V8_COVERAGE to every child; under the limit the child's coverage file would
 * be cut short and break `npm run coverage`, so the shell drops it.
 */
function runLimited(argv: string[], stdoutFile?: string): Promise<{ code: number; stderr: string }> {
  const redirect = stdoutFile === undefined ? "" : ' > "$OUT"';
  const sh = `trap '' XFSZ; ulimit -f 8; unset NODE_V8_COVERAGE; exec "$0" "$@"${redirect}`;
  return new Promise((resolve) =>
    execFile("/bin/sh", ["-c", sh, process.execPath, BIN, ...argv], { env: { PATH: process.env.PATH ?? "", OUT: stdoutFile ?? "" } }, (err, _stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr }),
    ),
  );
}

async function withServer(body: (base: string, requests: () => number) => Promise<void>): Promise<void> {
  const answer = bigAnswer();
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    res.setHeader("content-type", answer.contentType);
    res.end(answer.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => count);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("P26: a write cut short leaves the old file as it was, and no half-written file", STARTS_A_PROCESS, async () => {
  const dir = mkdtempSync(join(tmpdir(), `${PROGRAM}-p26-`));
  try {
    await withServer(async (base) => {
      const keep = join(dir, "keep.json");
      writeFileSync(keep, '{"previous":"result"}\n');
      const forced = await runLimited(outputArgv(base, keep, true));
      assert.equal(forced.code, 1, forced.stderr);
      assert.match(forced.stderr, new RegExp(`ERROR \\[${PROGRAM}\\.output\\] Could not write to ".*keep\\.json": .*EFBIG`), forced.stderr);
      assert.equal(readFileSync(keep, "utf8"), '{"previous":"result"}\n');

      const fresh = await runLimited(outputArgv(base, join(dir, "new.json"), false));
      assert.equal(fresh.code, 1, fresh.stderr);
      assert.deepEqual(readdirSync(dir), ["keep.json"], "no cut file and no temporary file is left");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P26: an existing file without --force is refused before any request", STARTS_A_PROCESS, async () => {
  const dir = mkdtempSync(join(tmpdir(), `${PROGRAM}-p26-`));
  try {
    await withServer(async (base, requests) => {
      const keep = join(dir, "keep.json");
      writeFileSync(keep, "mine");
      const refused = await runLimited(outputArgv(base, keep, false));
      assert.equal(refused.code, USAGE_EXIT, refused.stderr);
      assert.match(refused.stderr, /Refusing to overwrite existing file/);
      assert.equal(requests(), 0, "a request was sent");
      assert.equal(readFileSync(keep, "utf8"), "mine");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P26: stdout redirected to a file and cut short is an error (exit 1, ERROR of output), never exit 0", STARTS_A_PROCESS, async () => {
  const dir = mkdtempSync(join(tmpdir(), `${PROGRAM}-p26-`));
  try {
    await withServer(async (base) => {
      const out = join(dir, "stdout.json");
      const cut = await runLimited(stdoutArgv(base), out);
      assert.equal(cut.code, 1, cut.stderr);
      assert.match(cut.stderr, new RegExp(`ERROR \\[${PROGRAM}\\.output\\] Could not write to stdout: .*EFBIG`), cut.stderr);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
