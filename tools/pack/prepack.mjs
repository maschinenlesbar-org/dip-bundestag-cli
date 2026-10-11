// Everything a published app's tarball needs that the repository keeps elsewhere.
// Runs as the app's `prepack` (npm runs it in the app's folder, e.g. apps/cli), after
// the build. The same file is used by every maschinenlesbar.org CLI repository.
//
// The app is built from private workspace packages (packages/client, …) that are never
// published. They ship inside the app's tarball as plain files under `dist/node_modules/`:
// Node and TypeScript resolve a bare import by walking up to the nearest `node_modules`, so
// `dist/src/**` finds them there, while npm sees only files. That keeps them out of the
// published manifest — npm lists a package's `dependencies` on its registry page, and a
// private package there is a dependency nobody can install. (npm's own `bundleDependencies`
// would ship them too, but only names that are also `dependencies`.) So the app's
// package.json names no workspace package; the ones it needs are its TypeScript project
// references (tsconfig.json), and their own dependencies, transitively.
//
// Third-party runtime dependencies stay real dependencies and are bundled, dereferenced, into
// the app's `node_modules/` (`bundleDependencies`): a global install of a tarball whose
// bundled code depended on `commander` once created `node_modules/commander` as an **empty
// directory** and every command failed with ERR_MODULE_NOT_FOUND (openka-cli issue #1). A
// self-contained tarball also installs without the registry.
//
// It also copies the repository documents the tarball carries, because npm cannot reach
// outside the package folder: LICENSE, README.md, and every plain file name in `files`
// (LICENSING.md, DATA_LICENSE.md, ...). npm shows the package folder's README.md on the
// registry page, and that is the repository README; an app's own README.md is parked under
// a gitignored name for the length of the pack.
//
// Everything written here is generated and gitignored, and recorded in
// `.prepack-generated.json` so `postpack.mjs` removes exactly that. Left behind, the copies
// would **shadow the workspace symlinks** for anything running inside the app.
//
// No source maps: tsconfig.base.json emits none, and the copy skips any that an older build
// left in a `dist/`.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.cwd();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const manifest = readJson(join(target, "package.json"));
const at = relative(root, target).split(sep).join("/");
if (at === "" || at.startsWith("..")) throw new Error(`prepack: run it from a workspace package, not from ${target}`);

/** Every workspace package: name -> folder. `workspaces` patterns are folders or `dir/*`. */
function workspaces() {
  const map = new Map();
  for (const pattern of readJson(join(root, "package.json")).workspaces ?? []) {
    const folders = pattern.endsWith("/*")
      ? readdirSync(join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(root, pattern.slice(0, -2), entry.name))
      : [join(root, pattern)];
    for (const folder of folders) {
      if (existsSync(join(folder, "package.json"))) map.set(readJson(join(folder, "package.json")).name, folder);
    }
  }
  return map;
}
const packages = workspaces();

// The published manifest must not name a workspace package: npm would list it on the
// registry page (and could not install it), and `bundleDependencies` would bundle it into
// node_modules/ as an npm-managed dependency again.
const named = [...Object.keys(manifest.dependencies ?? {}), ...(manifest.bundleDependencies ?? [])].filter((name) =>
  packages.has(name),
);
if (named.length > 0) {
  throw new Error(
    `prepack: ${at}/package.json names workspace package(s) ${[...new Set(named)].join(", ")} in dependencies/bundleDependencies; ` +
      "they ship under dist/node_modules and are found through tsconfig.json's references — remove them",
  );
}
if (!(manifest.files ?? []).includes("dist/node_modules")) {
  throw new Error(`prepack: ${at}/package.json "files" must include "dist/node_modules", where the workspace packages ship`);
}

/** The workspace packages the app's TypeScript project references (tsconfig.json). */
function referenced() {
  const config = readJson(join(target, "tsconfig.json"));
  return (config.references ?? []).map(({ path }) => {
    const file = join(resolve(target, path), "package.json");
    if (!existsSync(file)) throw new Error(`prepack: tsconfig.json references ${path}, which has no package.json`);
    return readJson(file).name;
  });
}

/** The workspace packages `from` needs, transitively (dependencies import their own). */
function workspaceClosure(from) {
  const seen = new Set();
  const queue = [...from];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!packages.has(name) || seen.has(name)) continue;
    seen.add(name);
    queue.push(...Object.keys(readJson(join(packages.get(name), "package.json")).dependencies ?? {}));
  }
  return [...seen].sort();
}

/** The third-party packages the app and its bundled packages need at run time, transitively. */
function thirdPartyClosure(manifests) {
  const seen = new Set();
  const queue = manifests.flatMap((m) => Object.keys(m.dependencies ?? {}));
  while (queue.length > 0) {
    const name = queue.shift();
    if (packages.has(name) || seen.has(name)) continue;
    seen.add(name);
    const file = join(root, "node_modules", name, "package.json");
    if (!existsSync(file)) throw new Error(`prepack: ${name} is not installed — run npm ci before packing`);
    queue.push(...Object.keys(readJson(file).dependencies ?? {}));
  }
  return [...seen].sort();
}

const closure = workspaceClosure(referenced());
const thirdParty = thirdPartyClosure([manifest, ...closure.map((name) => readJson(join(packages.get(name), "package.json")))]);

// `bundleDependencies` must name every third-party one, or npm packs none of them. A gap is
// an error, not something patched into the manifest here: the manifest stays the source of truth.
const declared = new Set(manifest.bundleDependencies ?? []);
const undeclared = thirdParty.filter((name) => !declared.has(name));
if (undeclared.length > 0) {
  throw new Error(`prepack: bundleDependencies of ${manifest.name} must name ${undeclared.join(", ")}`);
}

// The repository documents: LICENSE, README.md and the plain file names in `files`.
const documents = [
  "LICENSE",
  ...(manifest.files ?? []).filter((entry) => /^[^!*/]+$/.test(entry) && existsSync(join(root, entry))),
];

// Record first, so postpack can clean up after a pack that failed half-way; a record left by
// such a pack is cleaned up here before starting again (the same steps as postpack.mjs).
// The README step is recorded only once it has happened, so a cleanup never removes an
// app's own README.md.
const record = join(target, ".prepack-generated.json");
const parked = join(target, "package-readme.parked.md");
const cleanUp = () => {
  if (!existsSync(record)) return;
  const { paths, readme } = readJson(record);
  for (const path of paths) rmSync(join(target, path), { recursive: true, force: true });
  if (readme === "added") rmSync(join(target, "README.md"), { force: true });
  if (existsSync(parked)) renameSync(parked, join(target, "README.md"));
  rmSync(record, { force: true });
};
cleanUp();
for (const path of documents) {
  if (existsSync(join(target, path))) throw new Error(`prepack: ${at}/${path} exists; the copy from the repository root would replace it`);
}
const paths = ["node_modules", "dist/node_modules", ...documents];
writeFileSync(record, `${JSON.stringify({ paths }, null, 2)}\n`);

for (const name of documents) cpSync(join(root, name), join(target, name));
const readme = existsSync(join(target, "README.md")) ? "parked" : "added";
if (readme === "parked") renameSync(join(target, "README.md"), parked);
cpSync(join(root, "README.md"), join(target, "README.md"));
writeFileSync(record, `${JSON.stringify({ paths, readme }, null, 2)}\n`);

rmSync(join(target, "node_modules"), { recursive: true, force: true });
rmSync(join(target, "dist", "node_modules"), { recursive: true, force: true });
for (const name of closure) {
  const source = packages.get(name);
  if (!existsSync(join(source, "dist", "src"))) throw new Error(`prepack: ${name} has no dist/src — build before packing`);
  const destination = join(target, "dist", "node_modules", name);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, "dist", "src"), join(destination, "dist", "src"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  // The shipped manifest: no scripts or devDependencies, no exports into dist/test (not
  // shipped), and whose it is and under what licence, because a licence scanner reads each
  // manifest on its own.
  const packed = readJson(join(source, "package.json"));
  delete packed.scripts;
  delete packed.devDependencies;
  for (const key of Object.keys(packed.exports ?? {})) {
    if (key.startsWith("./test/")) delete packed.exports[key];
  }
  packed.license = manifest.license;
  packed.author = manifest.author;
  packed.repository = { ...manifest.repository, directory: relative(root, source).split(sep).join("/") };
  packed.homepage = manifest.homepage;
  writeFileSync(join(destination, "package.json"), `${JSON.stringify(packed, null, 2)}\n`);
}
for (const name of thirdParty) {
  cpSync(join(root, "node_modules", name), join(target, "node_modules", name), { recursive: true, dereference: true });
}

console.log(
  `prepack: ${documents.length + 1} document(s), ${closure.length} workspace package(s) under dist/node_modules, ` +
    `${thirdParty.length} bundled third-party (${thirdParty.join(", ") || "none"})`,
);
