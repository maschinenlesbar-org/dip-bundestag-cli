// `-o --force` writes only where the user meant it to (security audit 2026-10-27, class G). The
// shared checks are conformance test P30; this is the one P30 case dip skips (it reads back a bare
// array, which dip never writes), with dip's own answer:
// `--force` still follows the caller's own links, the directory owner's, and any link in a
// directory only its owner writes (the rule of Linux's fs.protected_symlinks, which the CLI
// applies itself since it resolves links by hand). Owners are injected (`nodeFilesFor`), so no test needs a second user or root.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
