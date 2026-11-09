// Conformance test P30 (security audit 2026-10-27, classes G and G2): `-o` writes only where
// the user meant it to.
// - `--force` follows a link only when the caller or the directory's owner made it, at every hop,
//   wherever the directory is sticky or others can write to it (the rule of Linux's
//   fs.protected_symlinks): a link another user planted in /tmp sent the answer over any file
//   the caller could replace. The kernel never saw that link, as the CLI resolves it by hand.
// - A path that can't be inspected (EACCES) is reported as that, not as an existing file.
// - A stream target is written only when the descriptor opened is a stream: a path classified as a
//   FIFO or a device and then switched to a regular file was appended to without --force.
// Owners are injected (`nodeFilesFor`), so no test needs a second user or root. In process; a repo
// without -o sets HAS_OUTPUT_OPTION to false and the tests are skipped. Shared across the *-cli
// repos; only the adapter differs.

import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpRequest } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
import { test as nodeTest, type TestOptions } from "node:test";
import { run as cliRun } from "../src/cli/run.js";
import { nodeFilesFor as dipFilesFor, type CliDeps, type CliIO, type LinkOwners, type OutputPathState } from "../src/cli/io.js";
import { DipClient as Client } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";
/**
 * The kit's `-o` files (`state`, `parentProblem`, `write`) over dip's (`outputState`,
 * `outputParentProblem`, `writeFile`, from `nodeFilesFor(owners)`). `write` reads `this.state`, so
 * a test can plant a stale classification: dip's `writeFile` reads the `outputState` of the object
 * it was made with, which is set to it.
 */
interface KitFiles {
  state(path: string): OutputPathState;
  parentProblem(path: string, overwrite: boolean): string | undefined;
  write(path: string, data: Buffer, overwrite: boolean): void;
}
const nodeFilesFor = (owners?: LinkOwners): KitFiles => ({
  state: (path) => dipFilesFor(owners).outputState(path),
  parentProblem: (path, overwrite) => dipFilesFor(owners).outputParentProblem(path, overwrite),
  write(path, data, overwrite) {
    const files = dipFilesFor(owners);
    files.outputState = (p) => this.state(p);
    files.writeFile(path, data, overwrite);
  },
});
/** `run`, taking the deps the body passes: dip's `-o` seam is part of its CliIO, which `files` fills. */
const run = (argv: string[], { files, io, ...deps }: Omit<CliDeps, "io"> & { io: Pick<CliIO, "out" | "err">; files: KitFiles }): Promise<number> =>
  cliRun(argv, {
    ...deps,
    io: {
      ...io,
      outputState: (path) => files.state(path),
      outputParentProblem: (path, overwrite) => files.parentProblem(path, overwrite),
      writeFile: (path, data, overwrite) => files.write(path, data, overwrite ?? false),
      outBinary: () => {},
    },
  });
/** Whether the CLI has `-o` (see P26). */
const HAS_OUTPUT_OPTION = true;
/** argv that writes the answer of one GET to `file` (a test key, so no credentials file is read). */
const outputArgv = (file: string, force: boolean): string[] => [
  "--api-key", "p30-test-key", "--max-retries", "0", "-o", file, ...(force ? ["--force"] : []), "vorgang", "list", "--filter", "f.titel=x",
];
/** A 2xx answer for that GET: dip writes the list's documents, `[{ "id": "a1" }]` as the body expects. */
const answer = () => jsonResponse({ numFound: 1, documents: [{ id: "a1" }] });
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
/**
 * One case reads back what -o wrote as `[{ "id": "a1" }]`; dip writes an answer as the API sent it
 * (a list envelope or a document, never a bare array), so it can't be that. The same rule is
 * checked with dip's own answer in output-links.test.ts ("--force still follows the caller's own
 * links …").
 */
const SKIPPED: Record<string, string> = {
  "P30: --force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes":
    "dip writes an envelope or a document, never the bare array the case reads back; output-links.test.ts checks the rule with dip's answer",
};
const test = (name: string, options: TestOptions, fn: () => void | Promise<void>): void => {
  void nodeTest(name, SKIPPED[name] === undefined ? options : { ...options, skip: SKIPPED[name] }, fn);
};
// --------------------------------------------------------------------------------------

const skip = !HAS_OUTPUT_OPTION;

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

async function runWith(files: ReturnType<typeof nodeFilesFor>, argv: string[]): Promise<{ code: number; err: string; requests: HttpRequest[] }> {
  const mock = makeMockTransport(answer);
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: () => {}, err: (s) => err.push(s) },
    env: {},
    createClient: (options) => new Client({ ...options, transport: mock.transport }),
    files,
  });
  return { code, err: untimed(err.join("\n")), requests: mock.calls };
}

/** A temporary directory with a victim file and a link `out.json` to it. */
function planted(): { dir: string; victim: string; link: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "p30-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "keep me\n");
  const link = join(dir, "out.json");
  symlinkSync(victim, link);
  return { dir, victim, link, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("P30: --force does not follow a link another user made in a shared directory, before any request", { skip }, async () => {
  const t = planted();
  try {
    // A directory others can write to counts, sticky or not.
    const open = await runWith(nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: { uid: ME, mode: 0o40777 } })), outputArgv(t.link, true));
    assert.equal(open.code, USAGE_EXIT, open.err);
    const files = nodeFilesFor(owners({ [t.link]: OTHER }, { [t.dir]: SHARED }));
    const o = await runWith(files, outputArgv(t.link, true));
    assert.equal(o.code, USAGE_EXIT, o.err);
    assert.equal(o.requests.length, 0);
    assert.match(o.err, /another user/);
    assert.ok(o.err.includes(t.link), o.err);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // At write time too (a link planted during the request): the write refuses it.
    assert.throws(() => files.write(t.link, Buffer.from("x"), true), /another user/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    assert.ok(lstatSync(t.link).isSymbolicLink());
  } finally {
    t.done();
  }
});

test("P30: the rule holds at every hop, a dangling last one included", { skip }, async () => {
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

test("P30: --force still follows the caller's own links, the directory owner's, and any link in a directory only its owner writes", { skip }, async () => {
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
      assert.deepEqual(JSON.parse(readFileSync(t.victim, "utf8")), [{ id: "a1" }], label);
      assert.ok(lstatSync(t.link).isSymbolicLink(), label);
    } finally {
      t.done();
    }
  }
});

test("P30: a path that can't be inspected is reported as such, not as an existing file", { skip: skip || process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "p30-"));
  try {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    const link = join(dir, "out.json");
    symlinkSync(join(closed, "x.json"), link);
    chmodSync(closed, 0o000);
    const o = await runWith(nodeFilesFor(), outputArgv(link, false));
    assert.equal(o.code, USAGE_EXIT, o.err);
    assert.equal(o.requests.length, 0);
    assert.doesNotMatch(o.err, /Refusing to overwrite existing file/);
    assert.match(o.err, /EACCES|permission/i);
  } finally {
    chmodSync(join(dir, "closed"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P30: a stream target is written only when the descriptor opened is a stream", { skip }, () => {
  const t = planted();
  try {
    // The path was a stream when it was classified and is a regular file (through a link) when
    // it is opened: without --force it is refused, and the file is not touched.
    const real = nodeFilesFor();
    const switched = { ...real, state: () => "stream" as const };
    assert.throws(() => switched.write(t.link, Buffer.from("appended\n"), false), /Refusing to overwrite/);
    assert.equal(readFileSync(t.victim, "utf8"), "keep me\n");
    // A real stream is still written in place.
    assert.doesNotThrow(() => real.write("/dev/null", Buffer.from("x"), false));
  } finally {
    t.done();
  }
});
