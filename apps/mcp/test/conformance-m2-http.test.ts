// Conformance test M2 (MCP kit, rollout plan 2026-11-19): Streamable HTTP as a client and an
// operator see it.
// - One endpoint, POST /mcp, serving a 2025-06-18 handshake statelessly; GET is 405, /healthz is
//   200, anything else 404; every stderr line is a record of `<program>.<area>`.
// - A body over 1 MiB is 413, answered from the declared length.
// - A request takes one of the 8 slots only once its body has arrived: slow bodies don't lock
//   everyone else out.
// - A non-loopback address is a WARN record (no authentication); loopback inside a container is a
//   WARN too (a published port can't reach it).
// - A usage error is one ERROR record and exit 2; a port in use is exit 1.
// Shared whole across the repos with an MCP server: nothing here is particular to one.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { MAX_ACTIVE_REQUESTS } from "../src/mcp/http.js";
import { run } from "../src/mcp/run.js";
import { PROGRAM } from "../src/mcp/version.js";
import { AUTH_TOKEN_REQUIRED } from "../src/mcp/auth.js";
import { authArgs, headers, INITIALIZE, send, TEST_AUTH_TOKEN, withServer } from "./harness.js";

const topic = (area: string): string => `\\[${PROGRAM.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\.${area}\\]`;

test("POST /mcp serves a 2025-06-18 handshake statelessly; GET is 405; /healthz is 200; anything else 404", async () => {
  const lines = await withServer([], async (port) => {
    const answer = await send(port, { headers: headers(port), body: INITIALIZE });
    assert.equal(answer.status, 200, answer.body);
    assert.match(answer.body, /"protocolVersion":"2025-06-18"/);
    assert.equal((await send(port, { method: "GET", headers: headers(port) })).status, 405);
    assert.equal((await send(port, { method: "GET", path: "/healthz", headers: headers(port) })).status, 200);
    assert.equal((await send(port, { path: "/other", headers: headers(port), body: INITIALIZE })).status, 404);
  });
  assert.ok(lines.every((line) => new RegExp(`^\\S+Z (INFO|WARN|ERROR) +${topic("\\w+")} `).test(line)), lines.join("\n"));
  assert.match(lines.join("\n"), new RegExp(`INFO  ${topic("mcp")} ${PROGRAM} \\S+ serving MCP on http://127\\.0\\.0\\.1:\\d+/mcp`));
});

test("a body over 1 MiB is 413", async () => {
  await withServer([], async (port) => {
    // Only the headers: the server answers from the declared length before reading a byte. (Sending
    // the whole body raced with the server's close and sometimes ended in a reset, not the answer.)
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(
          `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
            (AUTH_TOKEN_REQUIRED ? `Authorization: Bearer ${TEST_AUTH_TOKEN}\r\n` : "") +
            `Content-Length: ${1024 * 1024 + 1}\r\n\r\n`,
        ),
      );
      let data = "";
      socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(answer, /^HTTP\/1\.1 413 /);
  });
});

test("requests whose bodies are still arriving hold no slot: a slow body doesn't lock out the others", async () => {
  await withServer([], async (port) => {
    // As many connections as there are slots, each sending its headers and then only the first
    // byte of a 100-byte body.
    const slow = await Promise.all(
      Array.from(
        { length: MAX_ACTIVE_REQUESTS },
        () =>
          new Promise<net.Socket>((resolve, reject) => {
            const socket = net.connect(port, "127.0.0.1", () => {
              socket.write(
                `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
                  (AUTH_TOKEN_REQUIRED ? `Authorization: Bearer ${TEST_AUTH_TOKEN}\r\n` : "") +
                  `Content-Length: 100\r\n\r\n{`,
                () => resolve(socket),
              );
            });
            socket.on("error", reject);
          }),
      ),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const answer = await send(port, { headers: headers(port), body: INITIALIZE });
      assert.equal(answer.status, 200, answer.body);
    } finally {
      for (const socket of slow) socket.destroy();
    }
  });
});

test("a non-loopback address is a WARN record: the server has no authentication (or, with a token, it travels unencrypted)", async () => {
  const lines = await withServer(["--host", "0.0.0.0", "--allowed-hosts", "localhost,127.0.0.1"], async () => {});
  assert.match(
    lines.join("\n"),
    new RegExp(
      AUTH_TOKEN_REQUIRED
        ? `WARN  ${topic("http")} listening on 0\\.0\\.0\\.0: reachable from outside this container or machine\\. The bearer token travels unencrypted over plain HTTP: publish the port on 127\\.0\\.0\\.1 only \\(docker run -p 127\\.0\\.0\\.1:<host port>:\\d+\\) or put a TLS proxy in front\\.`
        : `WARN  ${topic("http")} listening on 0\\.0\\.0\\.0: reachable from outside this container or machine, and the server has no authentication\\. Publish the port on 127\\.0\\.0\\.1 only \\(docker run -p 127\\.0\\.0\\.1:<host port>:\\d+\\) or put an authenticating proxy in front\\.`,
    ),
  );
});

test("a usage error is one ERROR record and exit 2; a port in use is exit 1", async () => {
  const lines: string[] = [];
  const code = await run(["--port", "x"], { stdout: () => {}, stderr: (line) => lines.push(line), stopped: Promise.resolve() });
  assert.equal(code, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", new RegExp(`ERROR ${topic("mcp")} --port must be a whole number`));
  await withServer([], async (port) => {
    const busy: string[] = [];
    const again = await run(["--transport", "http", "--port", String(port), ...authArgs()], { stdout: () => {}, stderr: (line) => busy.push(line), stopped: Promise.resolve() });
    assert.equal(again, 1);
    assert.match(busy.join("\n"), new RegExp(`ERROR ${topic("http")} Could not listen`));
  });
});

test("loopback inside a container is a WARN: a published port can't reach it, --host 0.0.0.0 can", async () => {
  const inside = await withServer([], async () => {}, { inContainer: true });
  assert.match(
    inside.join("\n"),
    new RegExp(`WARN  ${topic("http")} listening on 127\\.0\\.0\\.1 inside a container: a published port \\(docker run -p\\) can't reach it\\. Add --host 0\\.0\\.0\\.0 to serve through the published port\\.`),
  );
  const outside = await withServer([], async () => {}, { inContainer: false });
  assert.doesNotMatch(outside.join("\n"), /inside a container/);
  const opened = await withServer(["--host", "0.0.0.0"], async () => {}, { inContainer: true });
  assert.doesNotMatch(opened.join("\n"), /inside a container/);
});
