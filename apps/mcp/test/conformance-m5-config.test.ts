// Conformance test M5 (MCP kit, rollout plan 2026-11-19): the server's options: defaults, bounds,
// and the refusals that happen before anything starts (a credential in --base-url among them: a
// server runs for others; and every value the client's constructor would refuse, so the server
// never fails building its client after it started). Shared whole across the repos with an MCP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/mcp/config.js";
import { newClient } from "./harness.js";

/** The client's own verdict on `options` (its constructor), with the test login where it needs one. */
function clientTakes(options: Record<string, unknown>): boolean {
  try {
    newClient(options);
    return true;
  } catch {
    return false;
  }
}

test("defaults: stdio, loopback, the localhost Host names, 45 s per call, 25000 characters, 10 pages", () => {
  const parsed = parseConfig([]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.deepEqual(
    { ...parsed.config },
    { transport: "stdio", host: "127.0.0.1", port: 3000, allowedHosts: ["localhost", "127.0.0.1", "[::1]"], allowedOrigins: [], authTokenFile: undefined, baseUrl: undefined, timeoutMs: 30000, callTimeoutMs: 45000, maxResultChars: 25000, maxPages: 10, userAgent: undefined, logFormat: "text" },
  );
});

test("every option parses", () => {
  const parsed = parseConfig(["--transport", "http", "--host", "0.0.0.0", "--port", "0", "--allowed-hosts", "MCP.example.org,localhost", "--allowed-origins", "https://App.Example.org,http://localhost:6274", "--base-url", "https://mirror.example/", "--timeout", "0", "--call-timeout", "1000", "--max-result-chars", "1000", "--max-pages", "1", "--user-agent", "test/1", "--log-format", "jsonl", "--auth-token-file", "/run/secrets/mcp-token"]);
  assert.equal(parsed.kind, "run");
  if (parsed.kind !== "run") return;
  assert.equal(parsed.config.transport, "http");
  assert.deepEqual(parsed.config.allowedHosts, ["mcp.example.org", "localhost"]);
  assert.equal(parsed.config.baseUrl, "https://mirror.example/");
  assert.deepEqual(parsed.config.allowedOrigins, ["https://app.example.org", "http://localhost:6274"]);
  assert.equal(parsed.config.logFormat, "jsonl");
  assert.equal(parsed.config.authTokenFile, "/run/secrets/mcp-token");
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
    ["--auth-token-file", "/run/secrets/mcp-token"],
    ["--transport", "http", "--auth-token-file", " "],
    ["--unknown"],
    ["positional"],
  ]) {
    const parsed = parseConfig(argv);
    assert.equal(parsed.kind, "error", JSON.stringify(argv));
  }
  const userinfo = parseConfig(["--base-url", "https://user:secret@mirror.example"]);
  assert.ok(userinfo.kind === "error" && !userinfo.message.includes("secret"), "the message doesn't repeat the password");
});

test("--base-url: refused at start wherever the client would refuse it, not when the server builds the client", () => {
  // Paths and forms some clients refuse beyond the shared base-URL rules (dwd: a version path).
  for (const baseUrl of ["https://mirror.example/", "https://mirror.example/api", "https://mirror.example/v30", "https://mirror.example/v16/", "http://127.0.0.1:9/a/b", "https://mirror.example:8443"]) {
    const parsed = parseConfig(["--base-url", baseUrl]);
    assert.equal(parsed.kind === "run", clientTakes({ baseUrl }), `${baseUrl}: ${parsed.kind === "error" ? parsed.message : "taken"}`);
    if (parsed.kind === "error") assert.match(parsed.message, /^--base-url: /);
  }
});

test("help and version", () => {
  assert.equal(parseConfig(["--help"]).kind, "help");
  assert.equal(parseConfig(["-V"]).kind, "version");
});
