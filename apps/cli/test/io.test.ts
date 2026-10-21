import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors, stderrAfterStdout, stdoutWriter } from "../src/cli/io.js";
import { DipError } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";
import { createLogger } from "../src/cli/log.js";

/** Run `body` with a fresh temp directory that is always cleaned up. */
function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dip-io-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeFile refuses to overwrite an existing file (DIP-04)", () => {
  withTempDir((dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "original");
    assert.throws(
      () => defaultIO.writeFile(path, Buffer.from("new")),
      (err) =>
        err instanceof DipError &&
        err.message === `Refusing to overwrite existing file "${path}"; pass --force to overwrite.`,
    );
    // The original file is untouched.
    assert.equal(readFileSync(path, "utf8"), "original");
  });
});

test("writeFile with force overwrites an existing file", () => {
  withTempDir((dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "original");
    defaultIO.writeFile(path, Buffer.from("new"), true);
    assert.equal(readFileSync(path, "utf8"), "new");
  });
});

test("writeFile creates a new file when none exists", () => {
  withTempDir((dir) => {
    const path = join(dir, "fresh.json");
    defaultIO.writeFile(path, Buffer.from("data"));
    assert.equal(readFileSync(path, "utf8"), "data");
  });
});

// Runs node under a file-size limit.
const STARTS_A_PROCESS = { timeout: 30_000 };
const IO_MODULE = fileURLToPath(new URL("../src/cli/io.js", import.meta.url));

/** `defaultIO.writeFile(path, 100 KB, force)` in a node whose files may grow to 1–2 blocks only. */
function writeUnderSizeLimit(path: string, force: boolean): Promise<string> {
  const script = `import { defaultIO } from ${JSON.stringify(IO_MODULE)};
try { defaultIO.writeFile(${JSON.stringify(path)}, Buffer.alloc(100_000, 120), ${force}); console.log("written"); }
catch (err) { console.log(err.message); }`;
  // SIGXFSZ ignored (inherited through exec), so the write fails with EFBIG instead of killing node.
  // Node passes NODE_V8_COVERAGE to the child; under the limit its coverage file was cut short
  // and `npm run coverage` failed to report, so the shell drops it (as P26 does).
  const sh = `trap '' XFSZ; ulimit -f 2; unset NODE_V8_COVERAGE; exec "$0" --input-type=module -e "$1"`;
  return new Promise((resolve) => execFile("/bin/sh", ["-c", sh, process.execPath, script], (_err, stdout, stderr) => resolve(stdout + stderr)));
}

test("an -o write that fails part-way leaves the old file as it was, and no cut file (bug 5, 2026-10-19)", STARTS_A_PROCESS, async () => {
  // `-o keep.json --force` under a full disk left keep.json as 1 MB of cut JSON, the previous
  // result gone; without --force a cut new file blocked the next run.
  const dir = mkdtempSync(join(tmpdir(), "dip-io-"));
  try {
    const keep = join(dir, "keep.json");
    writeFileSync(keep, '{"good":"previous result"}\n');
    assert.match(await writeUnderSizeLimit(keep, true), /^Could not write to ".*keep\.json": EFBIG/);
    assert.equal(readFileSync(keep, "utf8"), '{"good":"previous result"}\n');
    const fresh = join(dir, "new.json");
    assert.match(await writeUnderSizeLimit(fresh, false), /^Could not write to ".*new\.json": EFBIG/);
    assert.deepEqual(readdirSync(dir), ["keep.json"], "no cut file and no temporary file is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile with force keeps the old file's mode and writes through a symlink, as before (bug 5, 2026-10-19)", () => {
  withTempDir((dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "original");
    chmodSync(path, 0o600);
    defaultIO.writeFile(path, Buffer.from("new"), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    defaultIO.writeFile(link, Buffer.from("newer"), true);
    assert.equal(readFileSync(path, "utf8"), "newer");
    assert.ok(statSync(link, { throwIfNoEntry: true }) && readdirSync(dir).sort().join() === "latest.json,out.json");
  });
});

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function outputStreams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
    log,
  );
  return { stdout, stderr, exits, records };
}

test("another stdout write error is an ERROR record of dip.output, in the run's format, and exits 1", () => {
  const s = outputStreams();
  s.stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(s.exits, [1]);
  assert.deepEqual(s.records.map((line) => JSON.parse(line)), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "dip.output", msg: "Could not write to stdout: write EBADF" },
  ]);
});

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = outputStreams();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr is ignored, so a failed run keeps its exit code", () => {
  const s = outputStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("ENOTCONN (stdout is a socket whose reader has gone) is treated like EPIPE", () => {
  const s = outputStreams();
  s.stdout.emit("error", writeError("ENOTCONN"));
  s.stderr.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, [0]);
});

test("another stderr write error exits 1", () => {
  const s = outputStreams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("writeFile names a directory target instead of an overwrite refusal, with or without force", () => {
  withTempDir((dir) => {
    for (const force of [false, true]) {
      assert.throws(
        () => defaultIO.writeFile(dir, Buffer.from("x"), force),
        (err) => err instanceof DipError && err.message === `"${dir}" is a directory; give a file path to --output.`,
        String(force),
      );
    }
  });
});

test("writeFile turns other fs errors into a DipError naming the path", () => {
  withTempDir((dir) => {
    const path = join(dir, "missing", "out.json");
    assert.throws(
      () => defaultIO.writeFile(path, Buffer.from("x")),
      (err) => err instanceof DipError && err.message.startsWith(`Could not write to "${path}": ENOENT`),
    );
  });
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (D6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dip-stdout-"));
  try {
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: string[] = [];
      const fake = { fd, write: (text: string) => streamed.push(text), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream.
      stdoutWriter(fake)("x".repeat(100_000));
      assert.equal(readFileSync(path, "utf8").length, 100_000);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
      // A pipe or a terminal (no regular file) goes through the stream as before.
      const piped: string[] = [];
      stdoutWriter({ write: (text: string) => piped.push(text), emit: () => assert.fail("no error") })("y");
      assert.deepEqual(piped, ["y"]);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
