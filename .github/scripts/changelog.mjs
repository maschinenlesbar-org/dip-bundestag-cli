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
const log = git(["log", "--pretty=format:%s%x09%h", range]);
const commits = log
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [subject, hash] = line.split("\t");
    return { subject: subject ?? "", hash: hash ?? "" };
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
for (const { subject, hash } of commits) {
  const m = /^([a-z]+)(\([^)]*\))?:\s*(.*)$/.exec(subject);
  const heading = m ? (HEADINGS[m[1]] ?? "Other") : "Other";
  const text = m ? m[3] : subject;
  groups.get(heading).push(`- ${text} (${hash})`);
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
