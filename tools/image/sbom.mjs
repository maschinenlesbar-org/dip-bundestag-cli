// SBOMs of an OCI image archive, one CycloneDX file per platform, and optionally the
// vulnerability gate over them. CI only: it needs skopeo and downloads its tools.
//
//   node tools/image/sbom.mjs --archive x.oci.tar --name <topic>-cli-1.2.3 --out sbom [--gate true]
//
// syft and grype are release binaries pinned by sha256 in pins.json, with their update checks
// off. Each platform is cut out of the multi-arch archive with skopeo before syft reads it.
// The gate fails on a fixable high or critical finding only: distroless Debian often carries
// CVEs with no fix. Accepted findings go into .grype.yaml at the repository root, with a reason.
// grype downloads its vulnerability database when it runs, so the gate's answer changes from
// day to day; that is why it runs on push and weekly (images.yml), never in a release run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fail, parseArgs, pins, run } from "./docker.mjs";

const args = parseArgs(process.argv.slice(2), ["archive", "name", "out"]);
if (process.env.CI !== "true") fail("sbom.mjs runs in CI only");
if (!/^[a-z0-9][a-z0-9.-]*$/.test(args.name)) fail(`--name must be a file name stem, got ${args.name}`);
const archive = resolve(args.archive);
const out = resolve(args.out);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "sbom-"));
const env = { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: "false", GRYPE_CHECK_FOR_APP_UPDATE: "false" };

/** Download a pinned tool's linux/amd64 release, check its sha256, unpack it; returns the binary's path. */
async function tool(name) {
  const pin = pins.tools[name];
  const file = `${name}_${pin.version}_linux_amd64.tar.gz`;
  const response = await fetch(`https://github.com/anchore/${name}/releases/download/v${pin.version}/${file}`);
  if (!response.ok) fail(`${file}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== pin.linux_amd64) fail(`${file}: sha256 ${sha256}, pinned ${pin.linux_amd64}`);
  const dir = join(work, name);
  mkdirSync(dir);
  writeFileSync(join(dir, file), bytes);
  run("tar", ["-xzf", join(dir, file), "-C", dir, name]);
  return join(dir, name);
}

try {
  const syft = await tool("syft");
  const sboms = [];
  for (const platform of pins.platforms) {
    const arch = platform.split("/")[1];
    const single = join(work, `${arch}.oci.tar`);
    run("skopeo", ["copy", "--override-os", "linux", "--override-arch", arch, `oci-archive:${archive}`, `oci-archive:${single}`]);
    const sbom = join(out, `${args.name}.${arch}.image.cdx.json`);
    run(syft, ["scan", `oci-archive:${single}`, "--output", `cyclonedx-json=${sbom}`], { env });
    const components = JSON.parse(readFileSync(sbom, "utf8")).components?.length ?? 0;
    if (components === 0) fail(`${sbom} lists no components`);
    process.stdout.write(`ok ${platform}: ${components} components in ${sbom}\n`);
    sboms.push(sbom);
  }
  if (args.gate === "true") {
    const grype = await tool("grype");
    const config = existsSync(".grype.yaml") ? ["--config", ".grype.yaml"] : [];
    for (const sbom of sboms) {
      run(grype, [`sbom:${sbom}`, "--only-fixed", "--fail-on", "high", ...config], { env, inherit: true });
      process.stdout.write(`ok no fixable high or critical finding: ${sbom}\n`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
