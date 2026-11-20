// Build an app's multi-arch OCI image archive from its release tarball.
//
//   node tools/image/build.mjs --app cli --tarball dist-artifacts/<pkg>.tgz --out dist-artifacts/<name>.oci.tar
//
// Reproducible: the same tarball, Dockerfile, pins and SOURCE_DATE_EPOCH (default: the HEAD
// commit's time) give the same index digest. For that, buildx adds no provenance or SBOM
// attestation (they carry build timestamps) and the exporter rewrites file timestamps. Prints
// one JSON line: { app, archive, sha256, index, platforms }.

import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dockerEnv, fail, fromTar, here, parseArgs, pins, readIndex, run } from "./docker.mjs";

const args = parseArgs(process.argv.slice(2), ["app", "tarball", "out"]);
if (!/^[a-z][a-z0-9-]*$/.test(args.app)) fail(`--app must be a Dockerfile target, got ${args.app}`);
const tarball = resolve(args.tarball);
const out = resolve(args.out);
const env = dockerEnv();

const manifest = JSON.parse(fromTar(tarball, "package/package.json"));
const epoch = process.env.SOURCE_DATE_EPOCH ?? run("git", ["log", "-1", "--format=%ct", "HEAD"]).stdout.trim();
if (!/^\d+$/.test(epoch)) fail(`SOURCE_DATE_EPOCH is not a Unix time: ${epoch}`);
const revision = run("git", ["rev-parse", "HEAD"]).stdout.trim();
const source = String(manifest.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");

const labels = {
  "org.opencontainers.image.title": manifest.name,
  "org.opencontainers.image.description": manifest.description,
  "org.opencontainers.image.version": manifest.version,
  "org.opencontainers.image.licenses": manifest.license,
  "org.opencontainers.image.url": manifest.homepage,
  "org.opencontainers.image.source": source,
  "org.opencontainers.image.revision": revision,
  "org.opencontainers.image.created": new Date(Number(epoch) * 1000).toISOString(),
};
for (const [key, value] of Object.entries(labels)) if (!value) fail(`label ${key} is empty (check ${tarball}'s package.json)`);

// One builder per BuildKit pin, so a pin change never builds with a stale BuildKit.
const builder = `maschinenlesbar-${createHash("sha256").update(pins.buildkit).digest("hex").slice(0, 12)}`;
if (run("docker", ["buildx", "inspect", builder], { env, allowFail: true }).status !== 0) {
  run("docker", ["buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", `image=${pins.buildkit}`], { env });
}

const context = mkdtempSync(join(tmpdir(), "image-context-"));
try {
  copyFileSync(tarball, join(context, "app.tgz"));
  const build = [
    "buildx", "build",
    "--builder", builder,
    "--file", join(here, "Dockerfile"),
    "--target", args.app,
    "--platform", pins.platforms.join(","),
    "--provenance=false",
    "--sbom=false",
    "--build-arg", `BASE_IMAGE=${pins.base}`,
    ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--output", `type=oci,dest=${out},rewrite-timestamp=true`,
    context,
  ];
  run("docker", build, { env: { ...env, SOURCE_DATE_EPOCH: epoch }, inherit: true });
} finally {
  rmSync(context, { recursive: true, force: true });
}

const { digest, platforms } = readIndex(out);
if (platforms.join(",") !== [...pins.platforms].sort().join(",")) fail(`${out} holds ${platforms.join(", ")}, expected ${pins.platforms.join(", ")}`);
const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
process.stdout.write(JSON.stringify({ app: args.app, archive: out, sha256, index: digest, platforms }) + "\n");
