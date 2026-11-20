// Conformance test M3 (MCP kit, rollout plan 2026-11-19): DNS-rebinding protection on HTTP.
// - A foreign Host is 403; one on --allowed-hosts is served.
// - A browser Origin must be one of --allowed-origins exactly (scheme, host and port); none is
//   allowed by default, not even the server's own; `null` is refused; no Origin (not a browser)
//   passes.
// Shared whole across the repos with an MCP server: nothing here is particular to one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { headers, INITIALIZE, send, withServer } from "./harness.js";

test("a foreign Host is refused (DNS rebinding), an allowed one served", async () => {
  await withServer(["--allowed-hosts", "localhost,127.0.0.1,mcp.example.org"], async (port) => {
    assert.equal((await send(port, { headers: headers(port, { host: `evil.example:${port}` }), body: INITIALIZE })).status, 403);
    assert.equal((await send(port, { headers: headers(port, { host: "mcp.example.org" }), body: INITIALIZE })).status, 200);
  });
});

test("a browser Origin must be one of --allowed-origins exactly (scheme, host and port); none is allowed by default", async () => {
  await withServer(["--allowed-origins", "https://app.example.org,http://localhost:6274"], async (port) => {
    const status = async (origin: string) => (await send(port, { headers: headers(port, { origin }), body: INITIALIZE })).status;
    assert.equal(await status("https://app.example.org"), 200);
    assert.equal(await status("http://localhost:6274"), 200);
    assert.equal(await status("http://evil.example"), 403);
    assert.equal(await status("null"), 403);
    assert.equal(await status("http://localhost:9999"), 403, "another port is another origin");
    assert.equal(await status(`http://localhost:${port}`), 403, "the server serves no pages: its own origin isn't allowed either");
    assert.equal(await status("http://app.example.org"), 403, "another scheme");
    assert.equal(await status("https://app.example.org:8443"), 403);
    assert.equal(await status("https://app.example.org.evil.example"), 403);
  });
  await withServer([], async (port) => {
    assert.equal((await send(port, { headers: headers(port, { origin: "http://localhost:9999" }), body: INITIALIZE })).status, 403);
    assert.equal((await send(port, { headers: headers(port), body: INITIALIZE })).status, 200, "no Origin (not a browser) passes");
  });
});
