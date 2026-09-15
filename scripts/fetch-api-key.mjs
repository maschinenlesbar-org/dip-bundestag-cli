#!/usr/bin/env node
// Fetch the DIP API key published in the bundesAPI README.
//
// The key is NOT bundled with the client or the CLI (see src/client/client.ts).
// This script exists so a key can be obtained out-of-band when one is genuinely
// needed — i.e. for CI / local integration runs that hit the live API. It MUST
// NOT be wired into the CLI or any production code path: resolve the key here,
// outside the program, and hand it in via `--api-key` or the DIP_API_KEY
// environment variable. Typical CI usage:
//
//   DIP_API_KEY="$(node scripts/fetch-api-key.mjs)" npm test
//
// OUT OF DATE: the bundesAPI README no longer carries the current key. On
// 2026-09-15 DIP rejected its key with 401, while the key on the Bundestag's own
// DIP API help page worked. The current public key is published there:
//
//   https://dip.bundestag.de/über-dip/hilfe/api
//
// (stated in 2026 as valid until the end of May 2027). There is no documented,
// machine-readable source for that key: the help page states it in prose (its
// content endpoint returns an HTML paragraph), and the official OpenAPI spec shows
// it only as an example value. Rather than scrape either, copy the key from the
// page, or request a personal key from parlamentsdokumentation@bundestag.de. The
// script therefore prints a reminder to stderr, and every error names the page.
//
// Scraped with a simple regex on purpose — no HTML parser, no dependencies.

import { fileURLToPath } from "node:url";
import process from "node:process";

/** Where the script looks for a key (a third-party README, no longer current). */
export const SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/dip-bundestag-api/main/README.md";

/** Where the Bundestag publishes the current public key. */
export const HELP_PAGE_URL = "https://dip.bundestag.de/über-dip/hilfe/api";

const WHERE = `The current public DIP API key is published at ${HELP_PAGE_URL}.`;

/** `Authorization: ApiKey <token>` as documented in the README. */
const KEY_PATTERN = /ApiKey\s+([A-Za-z0-9._-]+)/;

/**
 * Fetch the source and scrape the API key. Throws on a non-OK response or when
 * no key can be found (so callers/CI fail loudly).
 */
export async function fetchApiKey() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "dip-bundestag-cli fetch-api-key" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${SOURCE_URL}: HTTP ${res.status}. ${WHERE}`);
  }
  const text = await res.text();
  const match = text.match(KEY_PATTERN);
  if (!match) {
    throw new Error(`No ApiKey found in ${SOURCE_URL}. ${WHERE}`);
  }
  return match[1];
}

// Run as a script: print just the key to stdout (so it composes in shells and
// CI) with a reminder on stderr, or the error to stderr with a non-zero exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const key = await fetchApiKey();
    process.stderr.write(
      `Note: this key comes from the bundesAPI README, which is out of date; DIP may ` +
        `reject it with 401. ${WHERE}\n`,
    );
    process.stdout.write(key + "\n");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
