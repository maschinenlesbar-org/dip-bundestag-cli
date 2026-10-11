// Bump an app's version, commit and tag — what `npm version` did when the repository
// root was the package. The same file is used by every maschinenlesbar.org CLI repository.
//
//   npm run bump -- <patch|minor|major|X.Y.Z> [app folder, default apps/cli]
//
// The version lives in the app's package.json (apps/cli/package.json), never in the root:
// the root package.json is a private workspace manifest with no version and no lifecycle.
// A plain `npm version` at the root is refused by the root's `preversion` script.
//
// Steps, as `npm version` takes them: refuse a dirty working tree; `npm version -w <app>
// --no-git-tag-version` (npm runs the app's own preversion/version/postversion scripts and
// updates package-lock.json); commit everything that changed with the bare version as the
// message (`changelog.mjs` recognises that commit as the release itself); create the
// annotated tag vX.Y.Z with the same message. Pushing the tag is left to the caller.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [bump, app = "apps/cli"] = process.argv.slice(2);
if (bump === undefined || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error("usage: npm run bump -- <patch|minor|major|X.Y.Z> [app folder, default apps/cli]");
  process.exit(2);
}
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

if (run("git", ["status", "--porcelain"]).trim() !== "") {
  console.error("bump: the working tree is not clean; commit or stash first");
  process.exit(1);
}
run("npm", ["version", bump, "--workspace", app, "--no-git-tag-version"]);
const { version } = JSON.parse(readFileSync(join(root, app, "package.json"), "utf8"));
run("git", ["add", "--all"]);
run("git", ["commit", "--quiet", "--message", version]);
run("git", ["tag", "--annotate", `v${version}`, "--message", version]);
console.log(`bump: ${app} is ${version}, committed and tagged v${version} (push the tag to release)`);
