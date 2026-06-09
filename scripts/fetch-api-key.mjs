#!/usr/bin/env node
// Fetch the Bundestag's published shared DIP API key from the authoritative
// upstream source.
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
// Note: the published shared key is rate-limited and rotates (a past value
// expired 2026-05-31). This script always returns whatever the upstream README
// currently documents; for reliable use request a personal key from
// parlamentsdokumentation@bundestag.de.
//
// Source: the bundesAPI README is what the rendered dip.bundestag.de API docs
// build on, and it carries the key in plain text. Scraped with a simple regex
// on purpose — no HTML parser, no dependencies.

import { fileURLToPath } from "node:url";
import process from "node:process";

/** Authoritative, plain-text source of the shared key. */
export const SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/dip-bundestag-api/main/README.md";

/** `Authorization: ApiKey <token>` as documented in the README. */
const KEY_PATTERN = /ApiKey\s+([A-Za-z0-9._-]+)/;

/**
 * Fetch the source and scrape the shared API key. Throws on a non-OK response
 * or when no key can be found (so callers/CI fail loudly).
 */
export async function fetchApiKey() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "dip-bundestag-cli fetch-api-key" },
  });
  if (!res.ok) {
    throw new Error(`Could not fetch ${SOURCE_URL}: HTTP ${res.status}`);
  }
  const text = await res.text();
  const match = text.match(KEY_PATTERN);
  if (!match) {
    throw new Error(`No ApiKey found in ${SOURCE_URL}`);
  }
  return match[1];
}

// Run as a script: print just the key to stdout (so it composes in shells and
// CI), or the error to stderr with a non-zero exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write((await fetchApiKey()) + "\n");
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
