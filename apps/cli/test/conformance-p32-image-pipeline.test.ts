// Conformance test P32 (the image pipeline of the MCP rollout, 2026-11-19; P31 covers the npm
// side). Reads the workflows and tools/image as text, no YAML parser:
// - The image job records the archive's digest and runs no npm, scanner or SBOM tool; the SBOM
//   job comes after it and its outputs are trusted for nothing; no gate in a release run.
// - The attest job checks out nothing and has exactly the permissions attesting needs.
// - The release job checks the archive against the image job's digest.
// - Every image and tool is pinned by digest or sha256; the Dockerfile pulls no frontend.
// - publish.yml publishes the release's own files (one npm job per app) and pushes the images
//   with the run's own token.
// Shared across the repos with images; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- adapter (per repo) -------------------------------------------------------------
/** The repository's topic: the images and release files are `<topic>-cli` and `<topic>-mcp`. */
const TOPIC = "dip-bundestag";
// --------------------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");
const release = read(".github/workflows/release.yml");
const images = read(".github/workflows/images.yml");
const pins = JSON.parse(read("tools/image/pins.json")) as {
  base: string;
  buildkit: string;
  registry: string;
  skopeo: string;
  tools: Record<string, { version?: string; linux_amd64?: string }>;
};

/** The jobs of a workflow by name, each as its text without comments. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.search(/^jobs:\s*$/m));
  const found = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  heads.forEach((head, i) => found.set(head[1] ?? "", body.slice(head.index, heads[i + 1]?.index ?? body.length).replace(/(^|\s)#.*$/gm, "$1")));
  return found;
}

const releaseJobs = jobs(release);
const job = (name: string): string => {
  const text = releaseJobs.get(name);
  assert.ok(text, `release.yml has a job ${name}`);
  return text;
};

test("the image job builds from the checked tarball, records the archive's digest and runs no npm, scanner or SBOM tool", () => {
  const image = job("image");
  assert.match(image, /sha256sum --check --strict/, "checks the tarball against the pack job's digest");
  assert.match(image, /needs\.pack\.outputs\.tarball-sha256/);
  assert.match(image, /tools\/image\/build\.mjs/);
  assert.match(image, /archive-sha256=\$\(sha256sum/, "records the archive's digest");
  assert.doesNotMatch(image, /\bnpm\b|sbom\.mjs|\bsyft\b|\bgrype\b|\btrivy\b/);
  assert.doesNotMatch(image, /contents:\s*write|id-token/);
});

test("the image SBOM job runs after the digest is recorded, without a gate, and its outputs are trusted for nothing", () => {
  const sbom = job("image-sbom");
  assert.match(sbom, /needs:.*\bimage\b/);
  assert.match(sbom, /"\$ARCHIVE_SHA256" "image\/\$ARCHIVE" "\$MCP_ARCHIVE_SHA256" "image\/\$MCP_ARCHIVE" \| sha256sum --check --strict/, "checks both archives first");
  assert.match(sbom, /needs\.image\.outputs\.archive-sha256/);
  assert.match(sbom, /tools\/image\/sbom\.mjs/);
  assert.doesNotMatch(sbom, /--gate/, "no vulnerability gate in a release run");
  assert.doesNotMatch(sbom, /^\s*outputs:/m);
  assert.doesNotMatch(release, /needs\.image-sbom\.outputs/);
});

test("the attest job checks out nothing, pins actions/attest and has exactly the permissions attesting needs", () => {
  const attest = job("attest");
  assert.doesNotMatch(attest, /actions\/checkout/);
  assert.match(attest, /uses:\s*actions\/attest@[0-9a-f]{40}\s/);
  const permissions = attest.slice(attest.indexOf("permissions:"), attest.indexOf("steps:"));
  const granted = [...permissions.matchAll(/^\s+([a-z-]+):\s*(\w+)/gm)].map((m) => `${m[1]}: ${m[2]}`).sort();
  assert.deepEqual(granted, ["artifact-metadata: write", "attestations: write", "contents: read", "id-token: write"]);
});

test("the release job checks the image archive against the image job's digest and attaches it with the image SBOMs", () => {
  const rel = job("release");
  assert.match(rel, /"\$ARCHIVE_SHA256" "image\/\$ARCHIVE" \| sha256sum --check --strict/);
  assert.match(rel, /"\$MCP_TARBALL_SHA256" "package\/\$MCP_TARBALL" "\$MCP_ARCHIVE_SHA256" "image\/\$MCP_ARCHIVE" \| sha256sum --check --strict/);
  assert.match(rel, /needs:.*\battest\b/);
  for (const asset of ['"image/$ARCHIVE"', '"image/$MCP_ARCHIVE"', '"package/$MCP_TARBALL"', `${TOPIC}-cli-\${VERSION}.amd64.image.cdx.json`, `${TOPIC}-mcp-\${VERSION}.arm64.image.cdx.json`, `${TOPIC}-mcp-\${VERSION}.cdx.json`, "SHA256SUMS"]) {
    assert.ok(rel.includes(asset), asset);
  }
});

test("images.yml gates on push and weekly, smoke-tests arm64 on an arm64 runner", () => {
  assert.match(images, /^\s+push:/m);
  assert.match(images, /^\s+schedule:/m);
  assert.match(images, /sbom\.mjs [^\n]*--gate true/);
  assert.match(images, /runs-on:\s*ubuntu-24\.04-arm/);
});

test("every image and tool is pinned, and the workflows' registry service matches pins.json", () => {
  for (const ref of [pins.base, pins.buildkit, pins.registry, pins.skopeo]) assert.match(ref, /@sha256:[0-9a-f]{64}$/, ref);
  for (const [name, tool] of Object.entries(pins.tools).filter(([name]) => name !== "comment")) {
    assert.match(tool.version ?? "", /^\d+\.\d+\.\d+$/, name);
    assert.match(tool.linux_amd64 ?? "", /^[0-9a-f]{64}$/, name);
  }
  for (const workflow of [release, images]) {
    const services = [...workflow.matchAll(/^\s+image:\s*(registry:\S+)/gm)].map((m) => m[1]);
    assert.ok(services.length > 0);
    for (const service of services) assert.equal(service, pins.registry);
  }
});

test("the Dockerfile pulls no frontend: no syntax directive", () => {
  assert.doesNotMatch(read("tools/image/Dockerfile"), /^#\s*syntax\s*=/im);
});

const publishJobs = jobs(read(".github/workflows/publish.yml"));
const publishJob = (name: string): string => {
  const text = publishJobs.get(name);
  assert.ok(text, `publish.yml has a job ${name}`);
  return text;
};

test("publish.yml publishes the release's own files, checked against the immutable release and release.yml's attestation for the tag", () => {
  for (const name of ["npm", "images"]) {
    const job = publishJob(name);
    assert.match(job, /gh release download/, name);
    assert.match(job, /gh release verify-asset "\$GITHUB_REF_NAME"/, name);
    assert.match(job, /gh attestation verify [^\n]*\n[^\n]*--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml"[^\n]*\n[^\n]*--source-ref "\$GITHUB_REF"/, name);
    assert.doesNotMatch(job, /npm (ci|install|test|pack)\b|npm run\b/, `${name} runs no dependency code`);
  }
  assert.match(publishJob("npm"), /npm publish "\$TARBALL" --provenance/);
  // One leg per app: a base key the include entries attach to. Without it, include entries that
  // share their keys collapse into one job and the CLI went unpublished (v0.11.0).
  const npm = publishJob("npm");
  assert.match(npm, /^\s+app: \[cli, mcp\]\s*$/m);
  assert.equal([...npm.matchAll(/^\s+- app: (cli|mcp)\s*$/gm)].length, 2);
  // Without ./ npm reads `release/x.tgz` as the GitHub repository release/x.tgz (0.10.0's publish run).
  assert.match(publishJob("npm"), /echo "TARBALL=\.\/release\/\$tarball"/);
});

test("publish.yml pushes the image with the run's own token, no stored credential, and removes the login", () => {
  const images = publishJob("images");
  assert.match(images, /packages:\s*write/);
  assert.doesNotMatch(images, /secrets\.|id-token|environment:|set -x/);
  assert.match(images, /skopeo login --username "\$GITHUB_ACTOR" --password-stdin ghcr\.io/);
  assert.match(images, /tools\/image\/push\.mjs/);
  assert.match(images, /if: always\(\)\s+run: rm -f "\$RUNNER_TEMP\/registry-auth\.json"/);
  assert.doesNotMatch(publishJob("npm"), /packages:\s*write/, "the npm job can't push images");
});
