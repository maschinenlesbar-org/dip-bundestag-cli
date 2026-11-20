// Conformance test M10 (MCP kit, rollout plan 2026-11-19): MCP.md is the npm page of the MCP
// package (prepack packs it as its README): its tool table must name exactly the server's tools,
// in order, and its links must be absolute, since npm shows the file outside the repository.
// Shared whole across the repos with an MCP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listTools } from "../src/mcp/server.js";

const readme = readFileSync(fileURLToPath(new URL("../../../../MCP.md", import.meta.url)), "utf8");

test("MCP.md's tool table names exactly the server's tools, in order", () => {
  const listed = [...readme.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(listed, listTools().map((t) => t.name));
});

test("MCP.md's links are absolute", () => {
  for (const [, target] of readme.matchAll(/\]\(([^)]+)\)/g)) assert.match(target ?? "", /^https:\/\//, target);
});
