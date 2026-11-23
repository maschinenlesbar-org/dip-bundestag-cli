// Conformance test M12 (MCP kit, rollout plan 2026-11-19): a bearer token for HTTP
// (`--auth-token-file`, src/mcp/auth.ts).
// - A server whose API is called with a personal account (api.ts: HTTP_NEEDS_AUTH_TOKEN) refuses
//   to serve HTTP without a token file; any server takes one, and stdio takes none.
// - The file is read once, at start, with the credentials file's rules: no link, not another
//   user's, readable by nobody else, one token of at least 32 characters; a refusal names the fix
//   and never the content.
// - Every POST /mcp must send `Authorization: Bearer <token>`: anything else is 401 with
//   `WWW-Authenticate: Bearer` and no detail; /healthz needs none; the Host check comes first.
// - The token never appears in a record.
// Shared whole across the repos with an MCP server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AUTH_TOKEN_REQUIRED, bearerMatches, readAuthTokenFile } from "../src/mcp/auth.js";
import { run } from "../src/mcp/run.js";
import { PROGRAM } from "../src/mcp/version.js";
import { INITIALIZE, send, startHttp, writeTokenFile } from "./harness.js";

const TOKEN = "m12-token-abcdefghijklmnopqrstuvwxyz-0123456789";
const records = (lines: string[]) => lines.join("\n");

/** The headers of an MCP POST, with only the Authorization given. */
const post = (port: number, authorization?: string) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  host: `127.0.0.1:${port}`,
  ...(authorization === undefined ? {} : { authorization }),
});

/** Run the server with `argv` until it stops on its own; its exit code and records. */
async function runOnce(argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await run(argv, { stdout: () => {}, stderr: (line) => lines.push(line), stopped: Promise.resolve() });
  return { code, lines };
}

test("a server that uses a personal account refuses HTTP without --auth-token-file: one ERROR record, exit 2", { skip: AUTH_TOKEN_REQUIRED ? false : "this server's API needs no personal account" }, async () => {
  const { code, lines } = await runOnce(["--transport", "http", "--port", "0"]);
  assert.equal(code, 2);
  assert.equal(lines.length, 1, records(lines));
  assert.match(lines[0] ?? "", new RegExp(`ERROR \\[${PROGRAM}\\.mcp\\] --transport http needs --auth-token-file <path>`));
});

test("stdio takes no token file, and an empty path is refused", async () => {
  assert.equal((await runOnce(["--auth-token-file", writeTokenFile(TOKEN)])).code, 2);
  assert.equal((await runOnce(["--transport", "http", "--auth-token-file", ""])).code, 2);
});

test("the token file's rules: no link, readable by nobody else, one token of 32 characters or more; the content is never echoed", async () => {
  const good = writeTokenFile(TOKEN);
  assert.equal(readAuthTokenFile(good), TOKEN, "a trailing line break is no part of the token");
  const dir = dirname(good);
  const link = join(dir, "link");
  symlinkSync(good, link);
  assert.throws(() => readAuthTokenFile(link), /is a symbolic link/);
  const open = join(dir, "open");
  writeFileSync(open, TOKEN, { mode: 0o600 });
  chmodSync(open, 0o644);
  assert.throws(() => readAuthTokenFile(open), /can be read by others \(mode 644\).*chmod 600/);
  assert.throws(() => readAuthTokenFile(good, { uid: (process.getuid?.() ?? 0) + 1 }), /belongs to another user/);
  assert.throws(() => readAuthTokenFile(join(dir, "missing")), /can't be read \(ENOENT\)/);
  assert.throws(() => readAuthTokenFile(dir), /not a regular file/);
  for (const [content, why] of [
    ["short-token", /at least 32 characters/],
    [`${TOKEN} ${TOKEN}`, /more than one token/],
    [`${TOKEN}\n${TOKEN}\n`, /more than one token/],
    [`${TOKEN}ä`, /more than one token/],
    ["x".repeat(5000), /bytes; a token file holds one token/],
  ] as const) {
    const path = join(dir, "bad");
    writeFileSync(path, content, { mode: 0o600 });
    assert.throws(
      () => readAuthTokenFile(path),
      (err: unknown) => err instanceof Error && why.test(err.message) && !err.message.includes(TOKEN.slice(0, 20)),
    );
  }
  // At start: an ERROR record of <program>.config naming the file, exit 1, nothing listens.
  const { code, lines } = await runOnce(["--transport", "http", "--port", "0", "--auth-token-file", open]);
  assert.equal(code, 1);
  assert.equal(lines.length, 1, records(lines));
  assert.match(lines[0] ?? "", new RegExp(`ERROR \\[${PROGRAM}\\.config\\] --auth-token-file ${open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: can be read by others`));
});

test("bearerMatches: the scheme in any case, the exact token; anything else is no match", () => {
  assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), true);
  for (const header of [undefined, "", "Bearer", `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`, TOKEN]) {
    assert.equal(bearerMatches(header, TOKEN), false, String(header));
  }
});

test("with a token, every POST /mcp must send it: else 401, WWW-Authenticate: Bearer, no detail; /healthz needs none", async () => {
  const file = writeTokenFile(TOKEN);
  const server = await startHttp(["--auth-token-file", file]);
  try {
    const ok = await send(server.port, { headers: post(server.port, `Bearer ${TOKEN}`), body: INITIALIZE });
    assert.equal(ok.status, 200, ok.body);
    const refusals = await Promise.all(
      [undefined, `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}${TOKEN}`, `Basic ${TOKEN}`, "Bearer "].map((authorization) =>
        send(server.port, { headers: post(server.port, authorization), body: INITIALIZE }),
      ),
    );
    for (const refused of refusals) {
      assert.equal(refused.status, 401);
      assert.equal(refused.headers["www-authenticate"], "Bearer");
      assert.deepEqual(JSON.parse(refused.body), { jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized." }, id: null });
    }
    assert.equal((await send(server.port, { method: "GET", path: "/healthz", headers: { host: `127.0.0.1:${server.port}` } })).status, 200);
    // The Host check comes first: a foreign Host is 403 with or without the token.
    assert.equal((await send(server.port, { headers: { ...post(server.port), host: "evil.example" }, body: INITIALIZE })).status, 403);
    // Read once, at start: a token written to the file later is not the token.
    writeFileSync(file, "another-token-0123456789abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 });
    assert.equal((await send(server.port, { headers: post(server.port, "Bearer another-token-0123456789abcdefghijklmnopqrstuvwxyz"), body: INITIALIZE })).status, 401);
    assert.equal((await send(server.port, { headers: post(server.port, `Bearer ${TOKEN}`), body: INITIALIZE })).status, 200);
  } finally {
    server.stop();
    assert.equal(await server.done, 0);
  }
  assert.match(records(server.lines), new RegExp(`INFO  \\[${PROGRAM}\\.http\\] every request must send the bearer token from `));
  assert.ok(!records(server.lines).includes(TOKEN), records(server.lines));
});
