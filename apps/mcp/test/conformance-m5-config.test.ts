// Conformance test M5 (MCP kit, rollout plan 2026-11-19): the server's options: defaults, bounds,
// and the refusals that happen before anything starts (a credential in --base-url among them: a
// server runs for others). Shared whole across the repos with an MCP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/mcp/config.js";

test("defaults: stdio, loopback, the localhost Host names, 45 s per call, 25000 characters, 10 pages", () => {
  const parsed = parseConfig([]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.deepEqual(
    { ...parsed.config },
    { transport: "stdio", host: "127.0.0.1", port: 3000, allowedHosts: ["localhost", "127.0.0.1", "[::1]"], allowedOrigins: [], baseUrl: undefined, timeoutMs: 30000, callTimeoutMs: 45000, maxResultChars: 25000, maxPages: 10, userAgent: undefined, logFormat: "text" },
  );
});

test("every option parses", () => {
  const parsed = parseConfig(["--transport", "http", "--host", "0.0.0.0", "--port", "0", "--allowed-hosts", "MCP.example.org,localhost", "--allowed-origins", "https://App.Example.org,http://localhost:6274", "--base-url", "https://mirror.example/", "--timeout", "0", "--call-timeout", "1000", "--max-result-chars", "1000", "--max-pages", "1", "--user-agent", "test/1", "--log-format", "jsonl"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.config.transport, "http");
  assert.deepEqual(parsed.config.allowedHosts, ["mcp.example.org", "localhost"]);
  assert.equal(parsed.config.baseUrl, "https://mirror.example/");
  assert.deepEqual(parsed.config.allowedOrigins, ["https://app.example.org", "http://localhost:6274"]);
  assert.equal(parsed.config.logFormat, "jsonl");
});

test("refused before anything starts", () => {
  for (const argv of [
    ["--transport", "sse"],
    ["--port", "70000"],
    ["--port", "-1"],
    ["--port", "1e3"],
    ["--timeout", "abc"],
    ["--call-timeout", "10"],
    ["--max-pages", "0"],
    ["--base-url", "ftp://x"],
    ["--base-url", "https://user:secret@mirror.example"],
    ["--allowed-hosts", "a,,b"],
    ["--allowed-origins", "app.example.org"],
    ["--allowed-origins", "https://app.example.org/path"],
    ["--allowed-origins", "ftp://app.example.org"],
    ["--allowed-origins", "null"],
    ["--log-format", "xml"],
    ["--user-agent", "a\nb"],
    ["--host", ""],
    ["--unknown"],
    ["positional"],
  ]) {
    const parsed = parseConfig(argv);
    assert.equal(parsed.kind, "error", JSON.stringify(argv));
  }
  const userinfo = parseConfig(["--base-url", "https://user:secret@mirror.example"]);
  assert.ok(userinfo.kind === "error" && !userinfo.message.includes("secret"), "the message doesn't repeat the password");
});

test("help and version", () => {
  assert.equal(parseConfig(["--help"]).kind, "help");
  assert.equal(parseConfig(["-V"]).kind, "version");
});
