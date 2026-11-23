// The built MCP server against the official MCP client, the way clients connect: over stdio
// (the bin as a child process) and over Streamable HTTP, each in the client's three modes:
// legacy (the 2025-11-25 handshake), auto (probes server/discover, 2026-07-28) and pinned
// 2026-07-28. Every tool is listed and the calls of interop.json are made against a mock upstream
// on loopback, which answers each path with interop.json's answer for it. Exits 1 on the first
// failure.
//
//   npm ci --ignore-scripts --prefix tools/interop && node tools/interop/interop.mjs
//
// interop.json (per repository): `answers` (path -> the JSON the mock sends, or { "$raw": text, "$type": content type }), `tools` (how many
// the server lists) and `calls`: each { name, arguments } and either `expect` (dotted paths into
// structuredContent and the value each must have) or `"error": true` (a tool error). An API with
// credentials adds `env` (variables both servers get, such as a test key, so neither reads a
// credentials file nor obtains a key over the network). `"authToken": true` starts the HTTP server
// with --auth-token-file (a test token in a file of mode 600; required where the API is called with
// a personal account), sends the token with every HTTP request and checks that a request without
// it is refused with 401.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const bin = fileURLToPath(new URL("../../apps/mcp/dist/src/mcp/index.js", import.meta.url));
const config = JSON.parse(readFileSync(new URL("interop.json", import.meta.url), "utf8"));

const upstream = http.createServer((req, res) => {
  // An answer is JSON, or { "$raw": text, "$type": content type } for an API that isn't JSON (XML, CSV).
  const body = config.answers[new URL(req.url, "http://x").pathname];
  const raw = body !== null && typeof body === "object" && typeof body.$raw === "string";
  res.writeHead(body === undefined ? 404 : 200, { "content-type": raw ? body.$type : "application/json" });
  res.end(raw ? body.$raw : JSON.stringify(body ?? { error: "no such path" }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${upstream.address().port}`;

const env = { ...process.env, ...(config.env ?? {}) };
const token = "interop-bearer-token-0123456789abcdefghijklmnop";
const tokenDir = config.authToken === true ? mkdtempSync(join(tmpdir(), "interop-token-")) : undefined;
if (tokenDir !== undefined) writeFileSync(join(tokenDir, "token"), `${token}\n`, { mode: 0o600 });
const authArgs = tokenDir === undefined ? [] : ["--auth-token-file", join(tokenDir, "token")];
const requestInit = tokenDir === undefined ? undefined : { headers: { Authorization: `Bearer ${token}` } };
const httpServer = spawn(process.execPath, [bin, "--transport", "http", "--port", "0", "--base-url", baseUrl, ...authArgs], { stdio: ["ignore", "ignore", "pipe"], env });
const endpoint = await new Promise((resolve, reject) => {
  let log = "";
  httpServer.stderr.on("data", (chunk) => {
    log += chunk;
    const found = /serving MCP on (http:\/\/\S+)/.exec(log);
    if (found) resolve(found[1]);
  });
  httpServer.once("exit", (code) => reject(new Error(`the HTTP server exited with ${code}: ${log}`)));
});

/** The value at a dotted path (`tally.no_show`, `items.0.id`) of `value`. */
const at = (value, path) => path.split(".").reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value);

let failed = false;
if (tokenDir !== undefined) {
  // Without the token: refused before anything else.
  const refused = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  if (refused.status !== 401 || refused.headers.get("www-authenticate") !== "Bearer") {
    failed = true;
    console.log(`FAILED http without the bearer token: HTTP ${refused.status}, expected 401 with WWW-Authenticate: Bearer`);
  } else console.log("ok http without the bearer token: 401");
}
const modes = [["legacy", "legacy", "2025-11-25"], ["auto", "auto", "2026-07-28"], ["pinned", { pin: "2026-07-28" }, "2026-07-28"]];
try {
  for (const kind of ["stdio", "http"]) {
    for (const [label, mode, expected] of modes) {
      const client = new Client({ name: "interop", version: "0" }, { versionNegotiation: { mode } });
      const transport =
        kind === "stdio"
          ? new StdioClientTransport({ command: process.execPath, args: [bin, "--base-url", baseUrl], stderr: "ignore", env })
          : new StreamableHTTPClientTransport(new URL(endpoint), requestInit === undefined ? undefined : { requestInit });
      try {
        await client.connect(transport);
        const version = client.getNegotiatedProtocolVersion();
        if (version !== expected) throw new Error(`negotiated ${version}, expected ${expected}`);
        const tools = (await client.listTools()).tools;
        if (tools.length !== config.tools) throw new Error(`${tools.length} tools, expected ${config.tools}`);
        for (const call of config.calls) {
          const result = await client.callTool({ name: call.name, arguments: call.arguments });
          const shown = JSON.stringify(result).slice(0, 300);
          if (call.error === true) {
            if (result.isError !== true) throw new Error(`${call.name}: expected a tool error, got ${shown}`);
            continue;
          }
          if (result.isError) throw new Error(`${call.name}: ${shown}`);
          for (const [path, value] of Object.entries(call.expect ?? {})) {
            if (JSON.stringify(at(result.structuredContent, path)) !== JSON.stringify(value)) throw new Error(`${call.name}: ${path} is not ${JSON.stringify(value)}: ${shown}`);
          }
        }
        console.log(`ok ${kind} ${label} (${version})`);
      } catch (err) {
        failed = true;
        console.log(`FAILED ${kind} ${label}: ${err.message}`);
        if (process.env.GITHUB_ACTIONS === "true") console.log(`::error::interop ${kind} ${label}: ${err.message}`);
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
} finally {
  httpServer.kill("SIGTERM");
  upstream.close();
  if (tokenDir !== undefined) rmSync(tokenDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
