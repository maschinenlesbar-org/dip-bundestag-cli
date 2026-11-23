// Conformance test M3 (MCP kit, rollout plan 2026-11-19): DNS-rebinding protection on HTTP.
// - A foreign Host is 403; one on --allowed-hosts is served.
// - A browser Origin must be one of --allowed-origins exactly (scheme, host and port); none is
//   allowed by default, not even the server's own; `null` is refused; no Origin (not a browser)
//   passes.
// - An allowed Origin gets CORS: its preflight (OPTIONS, no token needed) is 204 with the methods
//   and headers an MCP client sends, and every answer to it carries Access-Control-Allow-Origin;
//   any other Origin gets no CORS header, and a request without one none either.
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

test("an allowed Origin gets CORS: the preflight is answered and the answer is readable; no other origin gets it", async () => {
  const origin = "http://localhost:6274";
  await withServer(["--allowed-origins", origin], async (port) => {
    // A browser's preflight carries no credentials: no bearer token, even where one is required.
    const preflight = (from: string) =>
      send(port, { method: "OPTIONS", headers: { host: `127.0.0.1:${port}`, origin: from, "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version, authorization" } });
    const allowed = await preflight(origin);
    assert.equal(allowed.status, 204, allowed.body);
    assert.equal(allowed.headers["access-control-allow-origin"], origin);
    assert.match(String(allowed.headers["access-control-allow-methods"]), /\bPOST\b/);
    const allowedHeaders = String(allowed.headers["access-control-allow-headers"]).toLowerCase();
    for (const name of ["content-type", "accept", "authorization", "mcp-protocol-version", "mcp-session-id"]) assert.ok(allowedHeaders.split(/\s*,\s*/).includes(name), `${name} in ${allowedHeaders}`);
    assert.match(String(allowed.headers["vary"]), /\borigin\b/i);
    const post = await send(port, { headers: headers(port, { origin }), body: INITIALIZE });
    assert.equal(post.status, 200, post.body);
    assert.equal(post.headers["access-control-allow-origin"], origin);
    assert.match(String(post.headers["vary"]), /\borigin\b/i);
    assert.match(String(post.headers["access-control-expose-headers"]).toLowerCase(), /\bmcp-session-id\b/);
    const foreign = await preflight("http://evil.example");
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers["access-control-allow-origin"], undefined);
    const noOrigin = await send(port, { headers: headers(port), body: INITIALIZE });
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers["access-control-allow-origin"], undefined, "no Origin, no CORS");
  });
});
