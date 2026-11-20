// Container limits (cgroup v2 and v1) and what the CLI does with them: in a memory-limited
// container the default response cap follows the memory, so an oversized answer meets the cap's
// error before the kernel's OOM kill (exit 137, nothing said); under a pids limit Node can't work
// with, a request is refused with one ERROR record. And the program name before the command
// (`docker run <image> dip vorgang list`) is dropped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readContainerLimits, responseCapFor } from "../src/cli/limits.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import type { DipClient } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import type { ContainerLimits } from "../src/cli/limits.js";

const MiB = 1024 * 1024;
const files = (map: Record<string, string>) => (path: string) => {
  const text = map[path];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return text;
};

test("cgroup v2 limits are read; 'max' and missing files mean no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "134217728\n", "/sys/fs/cgroup/pids.max": "64\n" })), { memoryBytes: 128 * MiB, pids: 64 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/pids.max": "max\n" })), {});
  assert.deepEqual(readContainerLimits(files({})), {});
});

test("cgroup v1 limits are read; its 'unlimited' (a huge number) means no limit", () => {
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456\n", "/sys/fs/cgroup/pids/pids.max": "8\n" })), { memoryBytes: 256 * MiB, pids: 8 });
  assert.deepEqual(readContainerLimits(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" })), {});
});

test("the response cap is an eighth of the memory, at least 1 MiB, at most the 100 MiB default", () => {
  assert.equal(responseCapFor(128 * MiB), 16 * MiB);
  assert.equal(responseCapFor(4 * MiB), 1 * MiB);
  assert.equal(responseCapFor(64 * 1024 * MiB), 100 * MiB);
});

/** Run `argv` with a client that answers an empty list; what the CLI gave the client and said. */
async function under(limits: ContainerLimits, argv: string[]) {
  const err: string[] = [];
  let seen: number | undefined;
  let created = false;
  const deps: CliDeps = {
    io: { out: () => {}, err: (text) => void err.push(text), writeFile: () => {}, outBinary: () => {} },
    env: {},
    createClient: (options) => {
      created = true;
      seen = options.maxResponseBytes;
      return { vorgaenge: { list: async () => ({ numFound: 0, documents: [] }) } } as unknown as DipClient;
    },
    limits: () => limits,
  };
  const code = await run(argv, deps);
  return { code, err: err.join(""), created, cap: seen };
}

test("in a memory-limited container the default cap follows the memory; --max-response-bytes still wins", async () => {
  assert.equal((await under({ memoryBytes: 128 * MiB }, ["vorgang", "list"])).cap, 16 * MiB);
  assert.equal((await under({}, ["vorgang", "list"])).cap, undefined, "no limit: the client's own default (100 MiB)");
  assert.equal((await under({ memoryBytes: 128 * MiB }, ["--max-response-bytes", "5000", "vorgang", "list"])).cap, 5000);
});

test("under a pids limit below 12 a request is refused with one ERROR record and exit 1, not a crash", async () => {
  const tight = await under({ pids: 8 }, ["vorgang", "list"]);
  assert.equal(tight.code, 1);
  assert.equal(tight.created, false, "no request is attempted");
  assert.match(tight.err, /ERROR \[dip\.cli\] the container allows only 8 processes and threads \(--pids-limit 8\); the CLI needs at least 12\. Run it with --pids-limit 12 or more\./);
  assert.equal(tight.err.trim().split("\n").length, 1);
  assert.equal((await under({ pids: 12 }, ["vorgang", "list"])).code, 0);
});

test("the program name before the command is dropped: `dip vorgang list` works as `vorgang list`", async () => {
  const named = await under({}, ["dip", "vorgang", "list"]);
  assert.equal(named.code, 0, named.err);
  assert.equal(named.created, true);
  const twice = await under({}, ["dip", "dip", "vorgang", "list"]);
  assert.equal(twice.code, 2, "only one leading name is dropped");
});
