// Smoke-test an app's image (cli or mcp) the way users run it: read-only, no capabilities, an arbitrary uid,
// bounded memory and processes. What is repo-specific (a request command and the mock's
// answers) is in tools/image/smoke.json.
//
//   node tools/image/smoke.mjs --app cli --image 127.0.0.1:5000/<topic>-cli@sha256:…
//   node tools/image/smoke.mjs --app mcp --image 127.0.0.1:5000/<topic>-mcp@sha256:…
//
// Both: --version is the image's version label. CLI: --help exits 0; with --network none the
// command fails with the network exit code and exactly one ERROR record on stderr; against a
// mock upstream on an internal network the command succeeds; `docker stop` ends a call that
// waits on the upstream within 5 s with 143 (SIGTERM), not the kill after 10 s. MCP: an
// initialize piped into `docker run -i` is answered and the server exits when stdin ends; over
// HTTP (`--transport http`, the port published on loopback) an initialize is answered,
// /healthz is 200, a foreign Origin is 403, and `docker stop` ends it with 143 within 5 s. With
// `"authToken": true` in smoke.json (a server that uses a personal account and serves HTTP only with
// a bearer token), the HTTP server gets a token file (mode 600, mounted read-only, the container run
// as the file's owner, as its docs say) and the checks send the token; one without it must be 401.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dockerEnv, fail, here, parseArgs, run } from "./docker.mjs";

const args = parseArgs(process.argv.slice(2), ["app", "image"]);
if (args.app !== "cli" && args.app !== "mcp") fail(`--app must be cli or mcp, got ${args.app}`);
const config = JSON.parse(readFileSync(args.config ?? join(here, "smoke.json"), "utf8"));
const env = dockerEnv();
const image = args.image;
const id = randomBytes(4).toString("hex");
const network = `smoke-${id}`;
const mock = `smoke-mock-${id}`;
const waiting = `smoke-stop-${id}`;
const hardened = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--pids-limit", "64", "--user", "12345:12345"];
const docker = (dockerArgs, options = {}) => run("docker", dockerArgs, { env, ...options });
const ok = (label) => process.stdout.write(`ok ${label}\n`);
const check = (label, condition, detail) => (condition ? ok(label) : fail(`${label}: ${detail}`));

// The mock answers each path in config.answers on port 8080 (JSON, or { "$raw": text, "$type":
// content type } for an API that isn't JSON) and never answers on port 8081.
const MOCK = `
const http = require("node:http");
const answers = JSON.parse(process.env.MOCK_ANSWERS);
http.createServer((req, res) => {
  const body = answers[new URL(req.url, "http://mock").pathname];
  const raw = body !== null && typeof body === "object" && typeof body.$raw === "string";
  res.writeHead(body === undefined ? 404 : 200, { "content-type": raw ? body.$type : "application/json" });
  res.end(raw ? body.$raw : JSON.stringify(body ?? { error: "no such path" }));
}).listen(8080);
http.createServer((req) => console.log("waiting " + req.url)).listen(8081, () => console.log("ready"));
`;

/**
 * The command against `base` (the mock), or as it is without one (the offline run). A CLI with no
 * --base-url, whose commands take whole URLs (oparl), writes `{base}` into its command instead:
 * it becomes the mock's address, or offline https://mock:8080 (no cleartext warning, no network).
 */
function commandFor(base) {
  if (!config.command.some((arg) => arg.includes("{base}"))) return base === undefined ? config.command : ["--base-url", base, ...config.command];
  return config.command.map((arg) => arg.replaceAll("{base}", base ?? "https://mock:8080"));
}

function waitForLog(container, text) {
  for (let i = 0; i < 100; i += 1) {
    const logs = docker(["logs", container], { allowFail: true });
    if (logs.stdout.includes(text) || logs.stderr.includes(text)) return;
    run("sleep", ["0.1"]);
  }
  fail(`${container} never logged ${JSON.stringify(text)}`);
}

// An image loaded from an archive (the arm64 check) is already there and has no registry.
if (docker(["image", "inspect", image], { allowFail: true }).status !== 0) docker(["pull", "--quiet", image]);
try {
  const version = docker(["image", "inspect", "--format", '{{ index .Config.Labels "org.opencontainers.image.version" }}', image]).stdout.trim();
  const printed = docker(["run", "--rm", ...hardened, image, "--version"], { allowFail: true });
  check("--version", printed.status === 0 && printed.stdout.trim() === version, `exit ${printed.status}, printed ${JSON.stringify(printed.stdout)}, label ${version}`);
  if (args.app === "mcp") {
    await smokeMcp();
    process.exit(0);
  }

  const help = docker(["run", "--rm", ...hardened, image, "--help"], { allowFail: true });
  check("--help", help.status === 0 && help.stdout.includes("Usage:"), `exit ${help.status}`);

  const offline = docker(["run", "--rm", ...hardened, "--network", "none", image, ...commandFor(undefined)], { allowFail: true });
  const records = offline.stderr.trim().split("\n");
  const record = new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z ERROR \\[${config.bin}\\.\\w+\\] `);
  check(
    "no network: the network exit code and one ERROR record",
    offline.status === config.networkErrorExit && records.length === 1 && record.test(records[0]),
    `exit ${offline.status}, stderr ${JSON.stringify(offline.stderr)}`,
  );

  docker(["network", "create", "--internal", network]);
  docker([
    "run", "--detach", "--name", mock, "--network", network, "--network-alias", "mock", ...hardened,
    "--entrypoint", "/nodejs/bin/node", "--env", `MOCK_ANSWERS=${JSON.stringify(config.answers)}`, image, "-e", MOCK,
  ]);
  waitForLog(mock, "ready");

  const answered = docker(["run", "--rm", ...hardened, "--network", network, image, ...commandFor("http://mock:8080")], { allowFail: true });
  check("a request to the mock upstream", answered.status === 0 && answered.stdout.includes(config.expectStdout), `exit ${answered.status}, stdout ${JSON.stringify(answered.stdout.slice(0, 300))}, stderr ${JSON.stringify(answered.stderr.slice(0, 300))}`);

  docker(["run", "--detach", "--name", waiting, ...hardened, "--network", network, image, ...commandFor("http://mock:8081")]);
  waitForLog(mock, "waiting");
  const started = Date.now();
  docker(["stop", "--time", "10", waiting]);
  const took = Date.now() - started;
  const exitCode = Number(docker(["inspect", "--format", "{{ .State.ExitCode }}", waiting]).stdout.trim());
  check("docker stop ends a waiting call with SIGTERM's 143, in under 5 s", exitCode === 143 && took < 5000, `exit ${exitCode} after ${took} ms`);
} finally {
  docker(["rm", "--force", mock, waiting], { allowFail: true });
  docker(["network", "rm", network], { allowFail: true });
}

/** The MCP server's checks: stdio, then HTTP on a loopback port. */
async function smokeMcp() {
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const started = Date.now();
  const stdio = docker(["run", "--rm", "-i", ...hardened, "--network", "none", image], { input: `${initialize}\n`, allowFail: true });
  const answer = stdio.stdout.split("\n").find((line) => line.includes('"id":1')) ?? "";
  check(
    "stdio: an initialize is answered, and the end of stdin ends the server",
    stdio.status === 0 && answer.includes('"serverInfo"') && Date.now() - started < 15_000,
    `exit ${stdio.status}, stdout ${JSON.stringify(stdio.stdout.slice(0, 300))}, stderr ${JSON.stringify(stdio.stderr.slice(0, 300))}`,
  );
  const http = `smoke-mcp-${id}`;
  // The token file lives below the repository (colima shares only $HOME with its VM).
  const tokenDir = join(here, `.smoke-token-${id}`);
  const token = `smoke-${randomBytes(24).toString("hex")}`;
  const auth = config.authToken === true;
  try {
    let tokenArgs = [];
    let runAs = hardened;
    if (auth) {
      mkdirSync(tokenDir, { mode: 0o700 });
      writeFileSync(join(tokenDir, "token"), `${token}\n`, { mode: 0o600 });
      tokenArgs = ["--auth-token-file", "/run/secrets/mcp-token"];
      const owner = `${process.getuid()}:${process.getgid()}`;
      runAs = [...hardened.slice(0, hardened.indexOf("--user")), "--user", owner, "-v", `${join(tokenDir, "token")}:/run/secrets/mcp-token:ro`];
    }
    docker(["run", "--detach", "--name", http, ...runAs, "-p", "127.0.0.1::3000", image, "--transport", "http", "--host", "0.0.0.0", "--allowed-hosts", "localhost,127.0.0.1", ...tokenArgs]);
    const port = docker(["port", http, "3000/tcp"]).stdout.trim().split("\n")[0]?.split(":").pop();
    if (port === undefined || port === "") fail("the HTTP server's port isn't published");
    waitForLog(http, "serving MCP on http");
    const base = `http://127.0.0.1:${port}`;
    const post = async (headers = {}) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: initialize,
      });
      return { status: response.status, body: await response.text() };
    };
    const ok = await post();
    check("HTTP: POST /mcp answers an initialize", ok.status === 200 && ok.body.includes('"serverInfo"'), `HTTP ${ok.status}: ${ok.body.slice(0, 300)}`);
    const health = await fetch(`${base}/healthz`);
    check("HTTP: /healthz is 200", health.status === 200, `HTTP ${health.status}`);
    const foreign = await post({ origin: "http://evil.example" });
    check("HTTP: a foreign Origin is 403", foreign.status === 403, `HTTP ${foreign.status}`);
    if (auth) {
      const refused = await post({ authorization: "Bearer not-the-token" });
      check("HTTP: a request without the bearer token is 401", refused.status === 401, `HTTP ${refused.status}`);
    }
    const stopping = Date.now();
    docker(["stop", "--time", "10", http]);
    const took = Date.now() - stopping;
    const exitCode = Number(docker(["inspect", "--format", "{{ .State.ExitCode }}", http]).stdout.trim());
    check("docker stop ends the HTTP server with SIGTERM's 143, in under 5 s", exitCode === 143 && took < 5000, `exit ${exitCode} after ${took} ms`);
  } finally {
    docker(["rm", "--force", http], { allowFail: true });
    rmSync(tokenDir, { recursive: true, force: true });
  }
}
