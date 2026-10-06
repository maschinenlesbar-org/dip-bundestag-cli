// Conformance test P21 (follow-up round 2026-10-06): README.md ships in the npm tarball and is
// shown on npmjs.com, so a relative link in it must point at a file the package ships. Anything
// else becomes an absolute GitHub URL. "Shipped" follows package.json `files` (plain paths and
// `dir/` prefixes, `!` negations ignored) plus what npm always packs. No `npm pack` here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo root, from dist/test/ (compiled) or test/ (source). */
const ROOT = fileURLToPath(new URL(import.meta.url.includes("/dist/test/") ? "../../" : "../", import.meta.url));
const GITHUB_BLOB = "https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/";

/** Files npm packs whatever `files` says. */
function alwaysShipped(path: string): boolean {
  return path === "package.json" || /^README(\.|$)/i.test(path) || /^(LICENSE|LICENCE)(\.|$)/i.test(path);
}

function shipped(path: string, files: readonly string[]): boolean {
  if (alwaysShipped(path)) return true;
  return files
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/^\.\//, ""))
    .some((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`));
}

test("P21: every relative README link points at a file the npm package ships", () => {
  const readme = readFileSync(`${ROOT}README.md`, "utf8");
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { files?: string[] };
  const files = pkg.files ?? [];
  const targets = [...readme.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!);
  assert.ok(targets.length > 0, "README has links");
  const broken = targets
    .filter((t) => !/^(https?:|mailto:|#)/i.test(t))
    .map((t) => t.replace(/[#?].*$/, "").replace(/^\.\//, ""))
    .filter((path) => !shipped(decodeURIComponent(path), files));
  assert.deepEqual(
    broken,
    [],
    `README links to files the npm package doesn't ship; use ${GITHUB_BLOB}<path> (anchor kept) instead: ${broken.join(", ")}`,
  );
});
