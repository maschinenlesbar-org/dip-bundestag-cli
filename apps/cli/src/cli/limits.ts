// The container's limits, read from its cgroup (v2, then v1), for what the CLI can't otherwise
// see: in a memory-limited container, a response cap that the memory can't hold turns an
// oversized answer into the kernel's OOM kill (exit 137, nothing said) instead of the cap's error.
// Outside a container (or on macOS) nothing is found and nothing changes.

import { readFileSync } from "node:fs";

/**
 * The fewest processes and threads Node needs for a request (its libuv pool and V8's platform
 * threads): under 12 it died with exit 133 (8) or hung (4, before any code of the CLI runs).
 */
const MIN_PIDS = 12;

/**
 * Why the CLI can't start a request under these limits, or undefined: a pids limit Node can't
 * work with. The CLI's `action()` raises it as an error of the cli area (exit 1) before any
 * request.
 */
export function pidsProblem(limits: ContainerLimits): string | undefined {
  if (limits.pids === undefined || limits.pids >= MIN_PIDS) return undefined;
  return `the container allows only ${limits.pids} processes and threads (--pids-limit ${limits.pids}); the CLI needs at least ${MIN_PIDS}. Run it with --pids-limit ${MIN_PIDS} or more.`;
}

export interface ContainerLimits {
  /** The memory limit in bytes, when there is one. */
  memoryBytes?: number;
  /** The most processes and threads, when there is a limit. */
  pids?: number;
}

/** The client's default response cap (100 MiB), the most a memory-derived cap gives. */
const DEFAULT_RESPONSE_CAP = 100 * 1024 * 1024;

// cgroup v1 writes "no limit" as a huge number (about 2^63) instead of "max".
const UNLIMITED = 2 ** 50;

/** The limits in the cgroup files, read with `read` (default: the file system). */
export function readContainerLimits(read: (path: string) => string = (path) => readFileSync(path, "utf8")): ContainerLimits {
  const first = (...paths: string[]): number | undefined => {
    for (const path of paths) {
      let text: string;
      try {
        text = read(path).trim();
      } catch {
        continue;
      }
      if (!/^\d+$/.test(text)) return undefined; // "max": no limit
      const value = Number(text);
      return Number.isSafeInteger(value) && value < UNLIMITED ? value : undefined;
    }
    return undefined;
  };
  const memoryBytes = first("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const pids = first("/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max");
  return { ...(memoryBytes === undefined ? {} : { memoryBytes }), ...(pids === undefined ? {} : { pids }) };
}

/**
 * The default response cap under a memory limit: an eighth of it (decoding and parsing an answer
 * takes several times its size), at least 1 MiB, at most the client's default.
 */
export function responseCapFor(memoryBytes: number): number {
  return Math.min(DEFAULT_RESPONSE_CAP, Math.max(1024 * 1024, Math.floor(memoryBytes / 8)));
}
