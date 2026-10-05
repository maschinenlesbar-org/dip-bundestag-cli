// Conformance test P1 (fix plan 2026-10-06): no credential from a base URL reaches the
// CLI's output, whatever the password contains and wherever the URL is typed. Shared across
// the *-cli repos; only the adapter block below differs per repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DipClient as Client } from "../src/client/client.js";
/** The environment variable the CLI reads a base URL from, or undefined if it has none. */
const BASE_URL_ENV: string | undefined = undefined; // dip reads only DIP_API_KEY (see the keyed-repo part below)
/** A command that needs no arguments and makes one request. */
const SIMPLE_COMMAND = ["vorgang", "list"];
/** A command that takes one positional argument, for the "URL as argument" case. */
const ARG_COMMAND = ["vorgang", "get"];
/** An option that takes a value and validates it, for the "URL as option value" case. */
const VALUE_OPTION = "--timeout";
/** A successful answer to SIMPLE_COMMAND. */
const okBody = { numFound: 0, documents: [] };
/** The members this repo's CliIO has besides out/err. */
const IO_EXTRAS = { writeFile: () => {}, outBinary: () => {} };
/** Keyed repos: the secret flag, its environment variable and a command that ignores the key. */
const KEY_FLAG: string | undefined = "--api-key";
const KEY_ENV: string | undefined = "DIP_API_KEY";
const KEYLESS_COMMAND = ["obtain-key"];
// --------------------------------------------------------------------------------------

/** Passwords that defeated a pattern-based redaction in the 2026-10-05 sweep. */
const PASSWORDS = ["s3cret-pw", "pa#ss-pw", "pa?ss-pw", "pa/ss-pw", "pa ss-pw", "o'brien-pw", 'pa"ss-pw', "päss-pw", "p@ss-pw", "tab\tpw"];

/** Base-URL shapes per password: valid, rejected (query, fragment, port, scheme, space), schemeless. */
function urls(pw: string): string[] {
  return [
    `https://alice:${pw}@mirror.example`,
    `https://alice:${pw}@mirror.example/?x=1`,
    `https://alice:${pw}@mirror.example/#f`,
    `https://alice:${pw}@mirror.example:99999`,
    `ftp://alice:${pw}@mirror.example`,
    `https://alice:${pw}@mirror.example `,
    `alice:${pw}@mirror.example/api`,
  ];
}

function cli(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const transport = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
  });
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), ...IO_EXTRAS },
    env,
    createClient: (opts) => new Client({ ...opts, transport }),
    transport,
  };
  return { deps, text: () => [...out, ...err].join("\n") };
}

function assertNoSecret(text: string, pw: string, context: string): void {
  // The whole password, and its JSON-escaped form, must be absent.
  for (const form of [pw, JSON.stringify(pw).slice(1, -1)]) {
    assert.ok(!text.includes(form), `${context}: password ${JSON.stringify(pw)} printed:\n${text}`);
  }
}

for (const pw of PASSWORDS) {
  test(`P1: no output path prints the password ${JSON.stringify(pw)}`, async () => {
    for (const url of urls(pw)) {
      const argvs: string[][] = [
        ["--base-url", url, ...SIMPLE_COMMAND],
        [`--base-url=${url}`, ...SIMPLE_COMMAND],
        [url, ...SIMPLE_COMMAND], // forgot --base-url: unknown command
        [...SIMPLE_COMMAND, url], // surplus argument
        [...ARG_COMMAND, url], // as a positional value
        [VALUE_OPTION, url, ...SIMPLE_COMMAND], // as an option's value
        [`--bogus=${url}`, ...SIMPLE_COMMAND], // unknown option with the URL in it
        [`--compact=${url}`, ...SIMPLE_COMMAND], // boolean flag given the URL
        ["help", url],
      ];
      for (const argv of argvs) {
        const c = cli();
        await run(argv, c.deps);
        assertNoSecret(c.text(), pw, `argv ${JSON.stringify(argv)}`);
      }
      if (BASE_URL_ENV !== undefined) {
        for (const argv of [["--help"], [...SIMPLE_COMMAND, "--help"], ["help", ...SIMPLE_COMMAND], SIMPLE_COMMAND, []]) {
          const c = cli({ [BASE_URL_ENV]: url });
          await run(argv, c.deps);
          assertNoSecret(c.text(), pw, `${BASE_URL_ENV}=${JSON.stringify(url)} argv ${JSON.stringify(argv)}`);
        }
      }
    }
  });
}

test("P1: output without credentials is unchanged", async () => {
  const c = cli();
  const code = await run(SIMPLE_COMMAND, c.deps);
  assert.equal(code, 0);
  assert.ok(c.text().length > 0 && !c.text().includes("***"), c.text());
});

// ---- keyed repos: the API key itself (flag, environment, typed in the wrong place) ----

/** Keys a usage error must not echo: pasted with an invisible or typographic character. */
const BAD_KEYS = [
  "Pers0nal.QwErTyUiOpAsDfGhJkLzXcVbNm1234567890\u200b",
  "Pers0nal.QwErTyUiOpAsDfGhJkLzXcVbNm1234567890\u2019",
  "Pers0nal.QwErTyUiOpAsDfGhJkLzXcVbNm1234567890\u2013",
  "Pers0nal.QwErTyUiOp\nAsDfGhJkLzXcVbNm1234567890",
];
const GOOD_KEY = "SeKrEt1.abcdefghijklmnopqrstuvwxyz0123456789";
/** The visible part of a key: what a reader could copy from the terminal. */
const visible = (key: string): string[] => key.split(/[^\x21-\x7e]+/).filter((part) => part.length >= 8);

test("P1 (keyed): a rejected key is never echoed, by flag or environment", async (t) => {
  if (KEY_FLAG === undefined || KEY_ENV === undefined) return t.skip("this CLI takes no key");
  for (const key of BAD_KEYS) {
    const argvs: string[][] = [
      [KEY_FLAG, key, ...SIMPLE_COMMAND],
      [`${KEY_FLAG}=${key}`, ...SIMPLE_COMMAND],
      [KEY_FLAG, key, ...KEYLESS_COMMAND],
    ];
    for (const argv of argvs) {
      const c = cli();
      await run(argv, c.deps);
      for (const part of visible(key)) assert.ok(!c.text().includes(part), `argv ${JSON.stringify(argv)}:\n${c.text()}`);
    }
    for (const argv of [SIMPLE_COMMAND, ["--help"], ["help", ...SIMPLE_COMMAND]]) {
      const c = cli({ [KEY_ENV]: key });
      await run(argv, c.deps);
      for (const part of visible(key)) assert.ok(!c.text().includes(part), `${KEY_ENV} argv ${JSON.stringify(argv)}:\n${c.text()}`);
    }
  }
});

test("P1 (keyed): a key typed without its flag is not echoed in full", async (t) => {
  if (KEY_FLAG === undefined) return t.skip("this CLI takes no key");
  for (const argv of [[GOOD_KEY, ...SIMPLE_COMMAND], [...SIMPLE_COMMAND, GOOD_KEY], [VALUE_OPTION, GOOD_KEY, ...SIMPLE_COMMAND]]) {
    const c = cli();
    await run(argv, c.deps);
    assert.ok(!c.text().includes(GOOD_KEY), `argv ${JSON.stringify(argv)}:\n${c.text()}`);
  }
});
