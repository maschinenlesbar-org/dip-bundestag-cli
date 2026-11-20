// Shared helpers of the image scripts: the docker environment, running a command, arguments.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const pins = JSON.parse(readFileSync(join(here, "pins.json"), "utf8"));

/** Print `message` and end the script with exit 1. */
export function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  // In GitHub Actions also an annotation, which the public run page shows without the log.
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").slice(0, 4000)}\n`);
  process.exit(1);
}

/** `--name value` pairs of argv as an object; a missing `required` name fails. */
export function parseArgs(argv, required = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith("--") || argv[i + 1] === undefined) fail(`expected --name value pairs, got ${JSON.stringify(argv.slice(i))}`);
    args[name.slice(2)] = argv[i + 1];
  }
  for (const name of required) if (args[name] === undefined) fail(`--${name} is required`);
  return args;
}

/**
 * The environment docker runs with. In CI it is the runner's. Elsewhere it is a scratch
 * DOCKER_CONFIG that holds no login and names no credential helper, so the docker CLI never asks
 * the macOS Keychain: with no `auths` at all it would look for a native store by itself, hence
 * the one empty entry. The CLI plugins (buildx) are found through `cliPluginsExtraDirs`.
 * DOCKER_HOST must be set, since the user's own config (and its context) is not read.
 */
export function dockerEnv() {
  if (process.env.CI === "true") return process.env;
  if (!process.env.DOCKER_HOST) {
    fail("set DOCKER_HOST (for colima: unix://$HOME/.colima/default/docker.sock); outside CI the scripts don't read your docker config");
  }
  const dir = join(tmpdir(), "maschinenlesbar-docker-config");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plugins = join(homedir(), ".docker", "cli-plugins");
  const config = { auths: { "no-credentials.invalid": {} }, cliPluginsExtraDirs: existsSync(plugins) ? [plugins] : [] };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  return { ...process.env, DOCKER_CONFIG: dir };
}

/** Run a command; fail on a non-zero exit unless `allowFail`. Returns { status, stdout, stderr }. */
export function run(command, args, { env = process.env, input, allowFail = false, inherit = false } = {}) {
  const result = spawnSync(command, args, {
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    fail(`${command} ${args.join(" ")} exited ${result.status}${result.stderr ? `:\n${result.stderr.trim()}` : ""}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A file out of a tar archive (gzip is detected by tar). */
export function fromTar(archive, member) {
  return run("tar", ["-xOf", archive, member]).stdout;
}

/** The index digest of an OCI archive and the platforms it holds; fails unless it holds one index. */
export function readIndex(archive) {
  const top = JSON.parse(fromTar(archive, "index.json"));
  if (top.manifests?.length !== 1) fail(`${archive}: index.json should name one image index, names ${top.manifests?.length}`);
  const digest = top.manifests[0].digest;
  const index = JSON.parse(fromTar(archive, `blobs/sha256/${digest.slice("sha256:".length)}`));
  const platforms = (index.manifests ?? []).map((m) => `${m.platform?.os}/${m.platform?.architecture}`).sort();
  return { digest, platforms };
}
