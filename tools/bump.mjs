// Bump the version of the published apps, commit and tag — what `npm version` did when the
// repository root was the package. The same file is used by every maschinenlesbar.org CLI
// repository.
//
//   npm run bump -- <patch|minor|major|X.Y.Z>
//
// The version lives in each published app's package.json (apps/cli, apps/mcp: every apps/*
// that is not private), never in the root: the root package.json is a private workspace
// manifest with no version and no lifecycle. A plain `npm version` at the root is refused by the
// root's `preversion` script. The apps are released together (lockstep): one version, one tag
// vX.Y.Z, one GitHub Release, so they must agree before and after the bump. With one app this is
// what it always was.
//
// Steps, as `npm version` takes them: refuse a dirty working tree; `npm version <bump>
// --workspace <app>…` for every app in one call (npm runs each app's own
// preversion/version/postversion scripts and updates package-lock.json); commit everything that
// changed with the bare version as the message (`changelog.mjs` recognises that commit as the
// release itself); create the annotated tag vX.Y.Z with the same message. Pushing the tag is left
// to the caller.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const [bump] = args;
if (args.length !== 1 || bump === undefined || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error("usage: npm run bump -- <patch|minor|major|X.Y.Z>   (every published app under apps/, together)");
  process.exit(2);
}
const run = (command, argv) => execFileSync(command, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const manifest = (app) => JSON.parse(readFileSync(join(root, app, "package.json"), "utf8"));

const apps = readdirSync(join(root, "apps"))
  .map((name) => `apps/${name}`)
  .filter((app) => existsSync(join(root, app, "package.json")) && manifest(app).private !== true)
  .sort();
if (apps.length === 0) {
  console.error("bump: no published app under apps/");
  process.exit(1);
}
/** The apps' one version; exits when they differ. */
function sharedVersion(when) {
  const versions = new Set(apps.map((app) => manifest(app).version));
  if (versions.size !== 1) {
    console.error(`bump: the apps' versions differ ${when} (${apps.map((app) => `${app} ${manifest(app).version}`).join(", ")}); they are released together`);
    process.exit(1);
  }
  return [...versions][0];
}

if (run("git", ["status", "--porcelain"]).trim() !== "") {
  console.error("bump: the working tree is not clean; commit or stash first");
  process.exit(1);
}
sharedVersion("before the bump");
run("npm", ["version", bump, ...apps.flatMap((app) => ["--workspace", app]), "--no-git-tag-version"]);
const version = sharedVersion("after the bump");
run("git", ["add", "--all"]);
run("git", ["commit", "--quiet", "--message", version]);
run("git", ["tag", "--annotate", `v${version}`, "--message", version]);
console.log(`bump: ${apps.join(", ")} ${apps.length === 1 ? "is" : "are"} ${version}, committed and tagged v${version} (push the tag to release)`);
