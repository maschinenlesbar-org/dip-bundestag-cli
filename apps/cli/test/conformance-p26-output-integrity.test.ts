// Conformance test P26 (trend analysis 2026-10-21; fix plan 2026-10-21, D1, D5 and D6): `-o`
// never loses a file, and no output is cut short silently. A write cut short (a full disk, a
// quota; here a file-size limit) leaves the old file as it was and no half-written file or
// temporary file behind, and says so (exit 1, an ERROR record of <bin>.output); so does stdout
// redirected to a file. An existing file without --force, and a file whose directory is missing,
// are refused before any request. A device or a FIFO is written in place, without --force, and
// stays what it is. A signal during the write leaves no claim and no temporary file. --force
// through a dangling link creates the file it names; a 255-byte name is written. Runs the built
// bin in child processes. Shared across the *-cli repos that have -o; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createReadStream, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
/** An answer for that command of about `items` × 12 bytes, as the server sends it (any format the API speaks). */
const answerOf = (items: number): { body: string; contentType: string } => ({
  body: JSON.stringify({ numFound: items, documents: Array.from({ length: items }, (_, i) => ({ id: `${i}` })) }),
  contentType: "application/json",
});
/** An answer of about 200 kB. */
const bigAnswer = (): { body: string; contentType: string } => answerOf(10000);
/** Whether `text` is the whole of what the CLI writes for `answerOf(items)`. */
const complete = (text: string, items: number): boolean => {
  try {
    return (JSON.parse(text) as { documents: unknown[] }).documents.length === items;
  } catch {
    return false;
  }
};
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

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Start the bin; `whileRunning` may act on the child (send it a signal) before it ends. */
function runBin(argv: string[], whileRunning: (child: ReturnType<typeof spawn>) => void = () => {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...argv], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr }));
    whileRunning(child);
  });
}

async function withServer(
  body: (base: string, requests: () => number) => Promise<void>,
  answer = bigAnswer(),
  delayMs = 0,
): Promise<void> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    res.setHeader("content-type", answer.contentType);
    if (delayMs === 0) return void res.end(answer.body);
    // A slow answer: the first bytes now, the rest later.
    res.write(answer.body.slice(0, 10));
    setTimeout(() => res.end(answer.body.slice(10)), delayMs);
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

/** Run `body` in a fresh temp directory that is always removed. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `${PROGRAM}-p26-`));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("P26: stdout redirected to a file and cut short is an error (exit 1, ERROR of output), never exit 0", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    await withServer(async (base) => {
      const out = join(dir, "stdout.json");
      const cut = await runLimited(stdoutArgv(base), out);
      assert.equal(cut.code, 1, cut.stderr);
      assert.match(cut.stderr, new RegExp(`ERROR \\[${PROGRAM}\\.output\\] Could not write to stdout: .*EFBIG`), cut.stderr);
    });
  });
});

test("P26: a missing directory is refused before any request", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    await withServer(async (base, requests) => {
      const refused = await runBin(outputArgv(base, join(dir, "missing", "x.json"), false));
      assert.equal(refused.code, USAGE_EXIT, refused.stderr);
      assert.match(refused.stderr, /does not exist/);
      assert.equal(requests(), 0, "a request was sent");
      assert.deepEqual(readdirSync(dir), []);
    });
  });
});

test("P26: /dev/null and a FIFO with a reader are written in place, without --force, and stay what they are", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    await withServer(async (base) => {
      const devNull = await runBin(outputArgv(base, "/dev/null", false));
      assert.equal(devNull.code, 0, devNull.stderr);
      assert.ok(statSync("/dev/null").isCharacterDevice());

      const fifo = join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      const read = new Promise<string>((resolve, reject) => {
        let text = "";
        createReadStream(fifo, "utf8").on("data", (chunk) => (text += chunk)).on("end", () => resolve(text)).on("error", reject);
      });
      const written = await runBin(outputArgv(base, fifo, false));
      assert.equal(written.code, 0, written.stderr);
      assert.ok(complete(await read, 10000), "the reader got the whole answer");
      assert.ok(lstatSync(fifo).isFIFO(), "the FIFO is still a FIFO");
      assert.deepEqual(readdirSync(dir), ["fifo"], "no temporary file is left");

      // The shell's own descriptor (`-o /dev/stdout`, `>(…)`) is written in place too: to a pipe,
      // and to the file the shell opened (an existing regular file, no --force needed).
      const own = await runBin(outputArgv(base, "/dev/stdout", false));
      assert.equal(own.code, 0, own.stderr);
      assert.ok(complete(own.stdout, 10000), "stdout got the whole answer");
      const redirected = join(dir, "redirected.json");
      const toFile = await new Promise<{ code: number; stderr: string }>((resolve) =>
        execFile("/bin/sh", ["-c", 'unset NODE_V8_COVERAGE; exec "$0" "$@" > "$OUT"', process.execPath, BIN, ...outputArgv(base, "/dev/stdout", false)],
          { env: { PATH: process.env.PATH ?? "", OUT: redirected } }, (err, _stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stderr })),
      );
      assert.equal(toFile.code, 0, toFile.stderr);
      assert.ok(complete(readFileSync(redirected, "utf8"), 10000), "the redirected file got the whole answer");
      rmSync(redirected);
    });
  });
});

test("P26: --force through a dangling link creates the file it names; a 255-byte name is written", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    await withServer(async (base) => {
      const link = join(dir, "latest.json");
      symlinkSync("target.json", link);
      const through = await runBin(outputArgv(base, link, true));
      assert.equal(through.code, 0, through.stderr);
      assert.ok(lstatSync(link).isSymbolicLink(), "the link stays a link");
      assert.ok(complete(readFileSync(join(dir, "target.json"), "utf8"), 10000));

      const long = join(dir, `${"x".repeat(250)}.json`);
      const named = await runBin(outputArgv(base, long, false));
      assert.equal(named.code, 0, named.stderr);
      assert.ok(complete(readFileSync(long, "utf8"), 10000));
      assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "target.json", `${"x".repeat(250)}.json`]);
    });
  });
});

test("P26: a signal during the request or the write leaves no claim and no temporary file", STARTS_A_PROCESS, async () => {
  await inTempDir(async (dir) => {
    // During the request: nothing written, the process ends as interrupted.
    await withServer(async (base) => {
      const target = join(dir, "slow.json");
      const slow = await runBin(outputArgv(base, target, false), (child) => setTimeout(() => child.kill("SIGINT"), 500));
      assert.ok(slow.code === 130 || slow.signal === "SIGINT", `exit ${slow.code} ${slow.signal}: ${slow.stderr}`);
      assert.deepEqual(readdirSync(dir), []);
    }, bigAnswer(), 5000);
    // During the write: the signal is sent as soon as the temporary file appears.
    const items = 1_000_000;
    await withServer(async (base) => {
      for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
        const target = join(dir, `${signal}.json`);
        let sent = false;
        const run = await runBin(outputArgv(base, target, false), (child) => {
          const poll = (): void => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            if (readdirSync(dir).some((name) => name.endsWith(".tmp"))) {
              sent = child.kill(signal);
              return;
            }
            setImmediate(poll);
          };
          poll();
        });
        const left = readdirSync(dir);
        assert.deepEqual(left.filter((name) => name.endsWith(".tmp")), [], `${signal}: a temporary file is left (sent: ${sent})`);
        // Either the write finished before the signal was handled (then the file is whole), or
        // nothing is there; never an empty claim that the next run would refuse.
        if (left.includes(`${signal}.json`)) assert.ok(complete(readFileSync(target, "utf8"), items), `${signal}: a cut or empty file is left`);
        assert.ok(run.code === 0 || run.code === code, `${signal}: exit ${run.code} ${run.signal}: ${run.stderr}`);
        rmSync(target, { force: true });
      }
    }, answerOf(items));
  });
});
