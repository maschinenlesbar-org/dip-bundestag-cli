// Copy an OCI image archive to a registry, every platform and the index digest unchanged, and
// check that the registry now serves that digest. The same script pushes to the local test
// registry (images.yml, the local smoke run) and to ghcr.io (publish.yml).
//
//   node tools/image/push.mjs --archive x.oci.tar --to 127.0.0.1:5000/<topic>-cli:test
//
// skopeo on PATH is used as it is (in CI, with REGISTRY_AUTH_FILE for a login). Without one,
// outside CI, a digest-pinned skopeo container does it, with no credentials of any kind.

import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { dockerEnv, fail, parseArgs, pins, readIndex, run } from "./docker.mjs";

const args = parseArgs(process.argv.slice(2), ["archive", "to"]);
const archive = resolve(args.archive);
const target = args.to;
if (!/^[a-z0-9.:-]+(\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+$/.test(target)) fail(`--to must be registry/repository:tag, got ${target}`);
const { digest } = readIndex(archive);
const local = /^(127\.0\.0\.1|localhost)(:\d+)?\//.test(target);
const tls = local ? ["--dest-tls-verify=false"] : [];
const inspectTls = local ? ["--tls-verify=false"] : [];

const hasSkopeo = run("sh", ["-c", "command -v skopeo"], { allowFail: true }).status === 0;
let skopeo;
if (hasSkopeo) {
  skopeo = (skopeoArgs, file) => run("skopeo", skopeoArgs.map((a) => a.replace("{archive}", file ?? "")));
} else {
  if (process.env.CI === "true") fail("skopeo is not on PATH");
  if (!local) fail("outside CI, push only to a local registry");
  const env = dockerEnv();
  skopeo = (skopeoArgs, file) =>
    run("docker", [
      "run", "--rm", "--network", "host",
      ...(file ? ["-v", `${dirname(file)}:/in:ro`] : []),
      pins.skopeo,
      ...skopeoArgs.map((a) => a.replace("{archive}", file ? `/in/${basename(file)}` : "")),
    ], { env });
}

skopeo(["copy", "--all", "--preserve-digests", ...tls, "oci-archive:{archive}", `docker://${target}`], archive);
const raw = skopeo(["inspect", "--raw", ...inspectTls, `docker://${target}`]).stdout;
const served = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
if (served !== digest) fail(`${target} serves ${served}, the archive's index is ${digest}`);
process.stdout.write(JSON.stringify({ target, index: digest }) + "\n");
