// `-o --force` writes only where the user meant it to (security audit 2026-10-27, class G; the
// tests of create-cli-template's P30, adapted to dip's CliIO seam):
// - `--force` follows a link only when the caller or the directory's owner made it, at every hop,
//   wherever the directory is sticky or others can write to it (the rule of Linux's
//   fs.protected_symlinks): a link another user planted in /tmp sent the answer over any file
//   the caller could replace. The kernel never saw that link, as the CLI resolves it by hand.
// - A path that can't be inspected (EACCES) is reported as that, not as an existing file.
// Owners are injected (`nodeFilesFor`), so no test needs a second user or root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequest } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
import { DipClient } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import { run } from "../src/cli/run.js";
import { nodeFilesFor, type LinkOwners, type OutputFiles } from "../src/cli/io.js";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

/** argv that writes the answer of one GET to `file`. */
const outputArgv = (file: string, force: boolean): string[] => [
  "--api-key", "links-test-key", "--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "vorgang", "get", "1",
];
/** A 2xx answer for that GET. */
const ANSWER = { id: "1", typ: "Vorgang", titel: "t" };
const USAGE_EXIT = 2;

/** The caller, and another user who planted links. */
const ME = 1000;
const OTHER = 1001;
/** /tmp: owned by root, sticky and world-writable. */
const SHARED = { uid: 0, mode: 0o41777 };

/**
 * Owners as a test says: `links` maps a link's path to its owner (the caller otherwise), `dirs` a
 * directory's path to its owner and mode (the caller's, 0o40755, otherwise).
 */
function owners(links: Record<string, number>, dirs: Record<string, { uid: number; mode: number }>): LinkOwners {
  return {
    uid: ME,
    ownerOf: (path, follow) => (follow ? (dirs[path] ?? { uid: ME, mode: 0o40755 }) : { uid: links[path] ?? ME, mode: 0o120777 }),
  };
}

async function runWith(files: OutputFiles, argv: string[]): Promise<{ code: number; err: string; requests: HttpRequest[] }> {
  const mock = makeMockTransport(() => jsonResponse(ANSWER));
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: () => {}, err: (s) => err.push(s), outBinary: () => {}, ...files },
    env: {},
    createClient: (options) => new DipClient({ ...options, transport: mock.transport }),
  });
  return { code, err: untimed(err.join("\n")), requests: mock.calls };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dip-links-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("--force does not follow a link another user made in a shared directory, before any request (G, 2026-10-27)", async () => {
  const t = planted();
  try {
    // A directory others can write to counts, sticky or not.
    const open = await runWith(nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: { uid: ME, mode: 0o40777 } })), outputArgv(t.link, true));
    assert.equal(open.code, USAGE_EXIT, open.err);
    const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: SHARED }));
    const o = await runWith(files, outputArgv(t.link, true));
    assert.equal(o.code, USAGE_EXIT, o.err);
    assert.equal(o.requests.length, 0);
    assert.match(o.err, /ERROR \[dip\.cli\] .*another user/);
    assert.ok(o.err.includes(t.link), o.err);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // At write time too (a link planted during the request): the write refuses it.
    assert.throws(() => files.writeFile(t.link, Buffer.from("x"), true), /another user/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    assert.ok(lstatSync(t.link).isSymbolicLink());
  } finally {
    t.done();
  }
});

test("the link rule holds at every hop, a dangling last one included (G, 2026-10-27)", async () => {
  const t = planted();
  try {
    // own link -> a foreign link in the shared directory -> the victim
    const inner = join(t.dir, "inner");
    symlinkSync(t.victim, inner);
    const outer = join(t.dir, "outer.json");
    symlinkSync(inner, outer);
    const chain = await runWith(nodeFilesFor(owners({ [inner]: OTHER }, { [t.dir]: SHARED })), outputArgv(outer, true));
    assert.equal(chain.code, USAGE_EXIT, chain.err);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // A foreign dangling link: the file it names is not created.
    const dangling = join(t.dir, "dangling.json");
    const target = join(t.dir, "created-elsewhere.json");
    symlinkSync(target, dangling);
    const d = await runWith(nodeFilesFor(owners({ [dangling]: OTHER }, { [t.dir]: SHARED })), outputArgv(dangling, true));
    assert.equal(d.code, USAGE_EXIT, d.err);
    assert.throws(() => statSync(target));
  } finally {
    t.done();
  }
});

test("--force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes (G, 2026-10-27)", async () => {
  const cases: Array<[string, (t: ReturnType<typeof planted>) => LinkOwners]> = [
    ["the caller's own link in a shared directory", (t) => owners({}, { [t.dir]: SHARED })],
    ["a link of the shared directory's owner", (t) => owners({ [t.link]: 0 }, { [t.dir]: SHARED })],
    ["another user's link in a directory only its owner writes", (t) => owners({ [t.link]: OTHER }, { [t.dir]: { uid: OTHER, mode: 0o40755 } })],
    ["another user's link where no caller id exists", (t) => ({ ...owners({ [t.link]: OTHER }, { [t.dir]: SHARED }), uid: undefined })],
  ];
  for (const [label, who] of cases) {
    const t = planted();
    try {
      const o = await runWith(nodeFilesFor(who(t)), outputArgv(t.link, true));
      assert.equal(o.code, 0, `${label}: ${o.err}`);
      assert.deepEqual(JSON.parse(readFileSync(t.victim, "utf8")), ANSWER, label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});

test("an -o path that can't be inspected is reported as such, not as an existing file (G, 2026-10-27)", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dip-links-"));
  try {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    for (const force of [false, true]) {
      const o = await runWith(nodeFilesFor(), outputArgv(link, force));
      assert.equal(o.code, USAGE_EXIT, o.err);
      assert.equal(o.requests.length, 0);
      assert.doesNotMatch(o.err, /Refusing to overwrite existing file/);
      assert.match(o.err, /EACCES|permission/i);
    }
  } finally {
    chmodSync(join(dir, "closed"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
