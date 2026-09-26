import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors } from "../src/cli/io.js";

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
      (err) => (err as NodeJS.ErrnoException).code === "EEXIST",
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

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function outputStreams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exits: number[] = [];
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
  );
  return { stdout, stderr, exits };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = outputStreams();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr exits 0 as well", () => {
  const s = outputStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("another stderr write error exits 1", () => {
  const s = outputStreams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});
