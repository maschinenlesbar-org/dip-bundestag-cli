// Obtain the DIP API key.
//
// No key ships with this package (see client.ts). The Bundestag publishes a
// public key on its DIP API help page and rotates it (the one in place in 2026
// is stated as valid until the end of May 2027), so the key has to be read at
// run time rather than baked into a release.
//
// The help page itself is a JS single-page app with nothing in its served HTML,
// but the prose it renders is a plain JSON document from DIP's own content
// service — `content-api/v1/content/help-api` — and that document states the
// key. That is the authoritative source and the one tried first. The bundesAPI
// README, which this command used to read exclusively, is kept only as a
// fallback: its key has been rejected with 401 since at least 2026-09-15.
//
// Handing the user a key that does not work is worse than handing them none, so
// `obtainKey` *verifies* each candidate against the live API by default and
// moves on to the next candidate, then the next source, when one is rejected.
// It never returns a key it knows to be dead.

import type { Transport } from "./http.js";
import { nodeHttpTransport } from "./http.js";
import { DEFAULT_BASE_URL, assertHttpScheme } from "./engine.js";
import { DipError } from "./errors.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "DIP_API_KEY";

/** The machine-readable document behind the help page — states the current key. */
export const KEY_SOURCE_URL =
  "https://content.dip.bundestag.de/content-api/v1/content/help-api";

/** Fallback source: the community mirror, known to lag behind the current key. */
export const KEY_SOURCE_FALLBACK_URL =
  "https://raw.githubusercontent.com/bundesAPI/dip-bundestag-api/main/README.md";

/** The sources tried, in order, when no explicit `sourceUrl` is given. */
export const KEY_SOURCE_URLS = [KEY_SOURCE_URL, KEY_SOURCE_FALLBACK_URL] as const;

/** Where the Bundestag publishes the current key for a human reader. */
export const HELP_PAGE_URL = "https://dip.bundestag.de/über-dip/hilfe/api";

/** Who to ask for a personal key. */
export const KEY_CONTACT = "parlamentsdokumentation@bundestag.de";

/** The shape of a DIP key: a short prefix, a dot, a long body. */
const KEY_TOKEN = String.raw`[A-Za-z0-9_-]{6,12}\.[A-Za-z0-9_-]{30,48}`;

/**
 * Ways a source states the key, most specific first:
 *   1. the help document's prose — `… gültige API-Key lautet:<br />R2BZaee.Djd…`
 *   2. the README's header form — `Authorization: ApiKey OSOegLs.PR2…`
 * Anything token-shaped in the document is then tried as a last resort, because
 * a reworded sentence should not be the difference between a working key and
 * none. Every candidate is verified before it is returned.
 */
const LABELLED_KEY_PATTERNS = [
  new RegExp(String.raw`API-?Key\s+lautet\s*:?(?:\s|<[^>]*>)*(${KEY_TOKEN})`, "i"),
  new RegExp(String.raw`ApiKey\s+(${KEY_TOKEN})`),
];
const BARE_KEY_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(${KEY_TOKEN})(?![A-Za-z0-9_-])`,
  "g",
);

/** Never make more than this many verification requests against one source. */
const MAX_CANDIDATES_PER_SOURCE = 5;

const WHERE_TO_GET_ONE =
  `The current public key is published at ${HELP_PAGE_URL}; ` +
  `a personal key can be requested from ${KEY_CONTACT}.`;

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /** Pin a single source document (tests, mirrors) instead of trying each in turn. */
  sourceUrl?: string;
  /** API base URL used for the verification request. */
  baseUrl?: string;
  /** Check the candidate against the live API before returning it (default true). */
  verify?: boolean;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ObtainedKey {
  /** The key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /** Which source it came from, so callers can cite it. */
  sourceUrl: string;
  /** true = accepted by the live API; false = not checked. */
  verified: boolean;
}

/**
 * Every distinct key-shaped string in a source document, labelled forms first.
 *
 * Order is what matters: a value the document explicitly calls the API key is
 * tried before anything that merely looks like one.
 */
export function extractKeyCandidates(document: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined): void => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  for (const pattern of LABELLED_KEY_PATTERNS) add(pattern.exec(document)?.[1]);
  for (const match of document.matchAll(BARE_KEY_PATTERN)) add(match[1]);
  return candidates.slice(0, MAX_CANDIDATES_PER_SOURCE);
}

/**
 * Read the published key and (by default) prove it still works.
 *
 * Tries each source in turn and, within a source, each key-shaped candidate,
 * returning the first the live API accepts. Throws rather than returning a
 * placeholder when no source is reachable, none states a key, or none states
 * one the API accepts — so a caller never proceeds with a value that cannot
 * authenticate.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  const sources = options.sourceUrl !== undefined ? [options.sourceUrl] : [...KEY_SOURCE_URLS];
  const transport = options.transport ?? nodeHttpTransport;
  const userAgent = options.userAgent ?? "dip-bundestag-cli";
  const timeout = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  const verify = options.verify !== false;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  // The verification request carries the candidate key, so refuse a non-http(s)
  // base URL up front, as the engine does, whatever transport was injected.
  if (verify) assertHttpScheme(baseUrl);

  // Why each source failed, in order, so the final error can say what was tried.
  const failures: string[] = [];

  for (const sourceUrl of sources) {
    const response = await transport({
      method: "GET",
      url: sourceUrl,
      headers: {
        Accept: "application/json, text/plain, text/markdown;q=0.9, */*;q=0.8",
        "User-Agent": userAgent,
      },
      ...timeout,
    });
    if (response.status < 200 || response.status >= 300) {
      failures.push(`${sourceUrl} could not be read (HTTP ${response.status})`);
      continue;
    }

    const candidates = extractKeyCandidates(response.body.toString("utf8"));
    if (candidates.length === 0) {
      failures.push(`${sourceUrl} states no key`);
      continue;
    }
    if (!verify) return { key: candidates[0] as string, sourceUrl, verified: false };

    let rejected = 0;
    for (const key of candidates) {
      const check = await transport({
        method: "GET",
        url: `${baseUrl}/api/v1/vorgang`,
        headers: {
          Accept: "application/json",
          Authorization: `ApiKey ${key}`,
          "User-Agent": userAgent,
        },
        ...timeout,
      });
      if (check.status >= 200 && check.status < 300) return { key, sourceUrl, verified: true };
      if (check.status === 401 || check.status === 403) {
        rejected += 1;
        continue;
      }
      // Not an authentication verdict — the API is unwell, so stop rather than
      // blame the key or walk the remaining candidates against a broken host.
      throw new DipError(
        `Could not verify the key against ${baseUrl} (HTTP ${check.status}). ` +
          `Re-run with --no-verify to print it unchecked, or see ${HELP_PAGE_URL}.`,
      );
    }
    failures.push(
      `the key${rejected > 1 ? "s" : ""} published at ${sourceUrl} ` +
        `${rejected > 1 ? "are" : "is"} no longer accepted by DIP (HTTP 401)`,
    );
  }

  throw new DipError(`No usable DIP key: ${failures.join("; ")}. ${WHERE_TO_GET_ONE}`);
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(dip obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
