// Everything a published app's tarball needs that the repository keeps elsewhere.
// Runs as the app's `prepack` (npm runs it in the app's folder, e.g. apps/cli), after
// the build. The same file is used by every maschinenlesbar.org CLI repository.
//
// npm bundles `bundleDependencies` only from the *package's own* `node_modules`, and in a
// workspace the dependencies are symlinked into the **root** `node_modules` instead.
// Packing an app therefore produces a tarball without them, and a bin that cannot resolve
// a single import. So this materialises them: each workspace package the app needs
// (transitively) gets its manifest and built `dist/src` copied into the app's
// `node_modules/`, and so does every third-party runtime dependency, dereferenced.
//
// Third-party dependencies are bundled too, not left to npm: a global install of a tarball
// whose bundled packages depend on `commander` once created `node_modules/commander` as an
// **empty directory** and every command failed with ERR_MODULE_NOT_FOUND (openka-cli
// issue #1). A self-contained tarball also installs without the registry.
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
import { dirname, join, relative, sep } from "node:path";
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

const closure = workspaceClosure(Object.keys(manifest.dependencies ?? {}));
const thirdParty = thirdPartyClosure([manifest, ...closure.map((name) => readJson(join(packages.get(name), "package.json")))]);

// `bundleDependencies` must name all of them, or npm packs none of them. A gap is an error,
// not something patched into the manifest here: the manifest stays the source of truth.
const declared = new Set(manifest.bundleDependencies ?? []);
const undeclared = [...closure, ...thirdParty].filter((name) => !declared.has(name));
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
const paths = ["node_modules", ...documents];
writeFileSync(record, `${JSON.stringify({ paths }, null, 2)}\n`);

for (const name of documents) cpSync(join(root, name), join(target, name));
const readme = existsSync(join(target, "README.md")) ? "parked" : "added";
if (readme === "parked") renameSync(join(target, "README.md"), parked);
cpSync(join(root, "README.md"), join(target, "README.md"));
writeFileSync(record, `${JSON.stringify({ paths, readme }, null, 2)}\n`);

rmSync(join(target, "node_modules"), { recursive: true, force: true });
for (const name of closure) {
  const source = packages.get(name);
  if (!existsSync(join(source, "dist", "src"))) throw new Error(`prepack: ${name} has no dist/src — build before packing`);
  const destination = join(target, "node_modules", name);
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, "dist", "src"), join(destination, "dist", "src"), {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  // The bundled manifest: no scripts or devDependencies nobody installs, no exports into
  // dist/test (not bundled), and whose it is and under what licence, because a licence
  // scanner or SBOM reads each bundled manifest on its own.
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
  `prepack: ${documents.length + 1} document(s), ${closure.length} bundled workspace package(s), ` +
    `${thirdParty.length} third-party (${thirdParty.join(", ") || "none"})`,
);
