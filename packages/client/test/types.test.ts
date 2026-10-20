import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DipClient } from "../src/client.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("every option field takes undefined under exactOptionalPropertyTypes (bug 3, 2026-10-19)", STARTS_A_PROCESS, async () => {
  // `new DipClient({ apiKey: process.env.DIP_API_KEY })`, the documented example, failed with
  // TS2375 in a consumer that sets exactOptionalPropertyTypes: the fields were `?: T`.
  const dir = mkdtempSync(join(tmpdir(), "dip-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { DipClient, type DipClientOptions, type EngineOptions, type ListOptions, type ObtainKeyOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const a: DipClientOptions = allUndefined<DipClientOptions>();",
        "export const b: EngineOptions = allUndefined<EngineOptions>();",
        "export const c: ListOptions = allUndefined<ListOptions>();",
        "export const d: ObtainKeyOptions = allUndefined<ObtainKeyOptions>();",
        "export const e = new DipClient({ apiKey: process.env.DIP_API_KEY, timeoutMs: 15_000 });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means the default, as an omitted one does (bug 3, 2026-10-19)", async () => {
  const mt = makeMockTransport(() => jsonResponse({ numFound: 0, documents: [] }));
  const client = new DipClient({
    apiKey: undefined,
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.vorgaenge.list({ "f.titel": "Klima" }, { allowUnknownFilters: undefined, allowUnfilteredCursor: undefined });
  const req = mt.last();
  assert.equal(req.headers?.["Authorization"], undefined);
  assert.match(req.url, /^https:\/\/search\.dip\.bundestag\.de\/api\/v1\/vorgang\?/);
  assert.match(req.headers?.["User-Agent"] ?? "", /dip-bundestag/);
});
