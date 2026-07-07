import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "../src/cli/io.js";

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
