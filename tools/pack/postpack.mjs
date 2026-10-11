// Undo what `prepack.mjs` materialised, as recorded in `.prepack-generated.json`.
// Runs as the app's `postpack`, in the app's folder. The same file is used by every
// maschinenlesbar.org CLI repository.
//
// The copies in the app's `node_modules` and `dist/node_modules` would **shadow the
// workspace symlinks** for anything running inside the app (tests resolve the copy, not the
// source), and
// the copied documents would sit untracked next to the code. The app's own README.md,
// parked while the repository README stood in for it, goes back in place. The README is
// removed only when the record says prepack added it, never an app's own.

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const target = process.cwd();
const record = join(target, ".prepack-generated.json");
const parked = join(target, "package-readme.parked.md");
if (existsSync(record)) {
  const { paths, readme } = JSON.parse(readFileSync(record, "utf8"));
  for (const path of paths) rmSync(join(target, path), { recursive: true, force: true });
  if (readme === "added") rmSync(join(target, "README.md"), { force: true });
  if (existsSync(parked)) renameSync(parked, join(target, "README.md"));
  rmSync(record, { force: true });
}
console.log("postpack: removed the bundled packages and the document copies");
