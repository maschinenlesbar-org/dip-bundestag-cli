#!/usr/bin/env node
// Generates release-notes markdown from the commit log since the previous v*
// tag, grouped by Conventional Commits type prefix (feat/fix/docs/...). Run
// from the repo root inside the Release workflow, after a full-history
// checkout (fetch-depth: 0) of the tag currently being released.
//
//   node .github/scripts/changelog.mjs            # uses $GITHUB_REF_NAME
//   node .github/scripts/changelog.mjs v1.2.3      # explicit tag override

import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const currentTag =
  process.argv[2] ?? process.env.GITHUB_REF_NAME ?? git(["describe", "--tags", "--exact-match"]);

const tags = git(["tag", "--list", "v*", "--sort=-v:refname"])
  .split("\n")
  .filter(Boolean);
// Newest-first list; the previous release is the tag right after currentTag,
// not merely "any other tag" (which would pick the newest tag overall when
// currentTag isn't the newest — e.g. regenerating notes for an older release).
const currentIdx = tags.indexOf(currentTag);
const previousTag = currentIdx === -1 ? tags.find((t) => t !== currentTag) : tags[currentIdx + 1];

const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
// Subject, hash and body per commit, separated by ASCII unit/record separators (a body
// spans lines, so newlines can't delimit records).
const log = git(["log", "--pretty=format:%s%x1f%h%x1f%b%x1e", range]);
const commits = log
  .split("\x1e")
  .map((record) => record.replace(/^\n/, ""))
  .filter(Boolean)
  .map((record) => {
    const [subject, hash, body] = record.split("\x1f");
    return { subject: subject ?? "", hash: hash ?? "", body: body ?? "" };
  });

const HEADINGS = {
  feat: "Features",
  fix: "Fixes",
  docs: "Documentation",
  refactor: "Refactoring",
  perf: "Performance",
  test: "Tests",
  build: "Build / CI",
  ci: "Build / CI",
  chore: "Chores",
  style: "Chores",
  revert: "Reverts",
};
const ORDER = [
  "Behaviour changes",
  "Features",
  "Fixes",
  "Documentation",
  "Refactoring",
  "Performance",
  "Tests",
  "Build / CI",
  "Chores",
  "Reverts",
  "Other",
];

const groups = new Map(ORDER.map((h) => [h, []]));
// The commit `npm version` creates ("0.2.1") is the release itself, not a change.
const isVersionBump = (subject) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(subject);
for (const { subject, hash, body } of commits) {
  if (isVersionBump(subject)) continue;
  // `type(scope)!: text` marks a breaking change, as does a `BREAKING CHANGE:` footer.
  const m = /^([a-z]+)(\([^)]*\))?(!)?:\s*(.*)$/.exec(subject);
  const heading = m ? (HEADINGS[m[1]] ?? "Other") : "Other";
  const text = m ? m[4] : subject;
  groups.get(heading).push(`- ${text} (${hash})`);
  // List what a script or library caller has to adapt to once more, up front.
  // The footer runs to a blank line, the next `Token: ` trailer line, or the body's end.
  const footer = /(?:^|\n)BREAKING[ -]CHANGE:\s*([\s\S]*?)(?=\n\n|\n[A-Za-z-]+: |\s*$(?![\s\S]))/.exec(body);
  if (m?.[3] === "!" || footer) {
    const note = footer ? footer[1].replace(/\s+/g, " ").trim() : text;
    groups.get("Behaviour changes").push(`- ${note} (${hash})`);
  }
}

const lines = [];
lines.push(previousTag ? `Changes since ${previousTag}:` : "Initial release.");
lines.push("");
for (const heading of ORDER) {
  const items = groups.get(heading);
  if (items.length === 0) continue;
  lines.push(`### ${heading}`);
  lines.push(...items);
  lines.push("");
}

process.stdout.write(lines.join("\n").trimEnd() + "\n");
