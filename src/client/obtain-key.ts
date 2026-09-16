// Obtain the DIP API key.
//
// No key ships with this package (see client.ts). Unlike the sibling CLIs in
// this family, DIP's published key is a moving target: the bundesAPI README is
// the only machine-readable source, and the key it carries has been rejected
// with 401 since at least 2026-09-15, while the Bundestag publishes the current
// one in prose on its help page (a JS single-page app, so nothing to scrape).
//
// Handing the user a key that does not work is worse than handing them none, so
// `obtainKey` *verifies* the candidate against the live API by default and fails
// with the two places a working key actually comes from. It never returns a key
// it knows to be rejected.

import type { Transport } from "./http.js";
import { nodeHttpTransport } from "./http.js";
import { DEFAULT_BASE_URL } from "./engine.js";
import { DipError } from "./errors.js";

/** The environment variable the client and CLI read the key from. */
export const API_KEY_ENV_VAR = "DIP_API_KEY";

/** The only machine-readable source — known to lag behind the current key. */
export const KEY_SOURCE_URL =
  "https://raw.githubusercontent.com/bundesAPI/dip-bundestag-api/main/README.md";

/** Where the Bundestag publishes the current key, in prose. */
export const HELP_PAGE_URL = "https://dip.bundestag.de/über-dip/hilfe/api";

/** Who to ask for a personal key. */
export const KEY_CONTACT = "parlamentsdokumentation@bundestag.de";

/** `Authorization: ApiKey <token>` as documented in the source. */
const KEY_PATTERN = /ApiKey\s+([A-Za-z0-9._-]+)/;

const WHERE_TO_GET_ONE =
  `The current public key is published at ${HELP_PAGE_URL}; ` +
  `a personal key can be requested from ${KEY_CONTACT}.`;

export interface ObtainKeyOptions {
  /** Injectable transport; defaults to the built-in node:http/https one. */
  transport?: Transport;
  /** Override the source document (tests, mirrors). */
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
  /** Where it was read from, so callers can cite it. */
  sourceUrl: string;
  /** true = accepted by the live API; false = not checked. */
  verified: boolean;
}

/**
 * Read the published key and (by default) prove it still works.
 *
 * Throws rather than returning a placeholder when the source is unreachable, no
 * longer states a key, or states one the API rejects — so a caller never
 * proceeds with a value that cannot authenticate.
 */
export async function obtainKey(options: ObtainKeyOptions = {}): Promise<ObtainedKey> {
  const sourceUrl = options.sourceUrl ?? KEY_SOURCE_URL;
  const transport = options.transport ?? nodeHttpTransport;
  const userAgent = options.userAgent ?? "dip-bundestag-cli";
  const timeout = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};

  const response = await transport({
    method: "GET",
    url: sourceUrl,
    headers: { Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8", "User-Agent": userAgent },
    ...timeout,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new DipError(
      `Could not read the key source ${sourceUrl} (HTTP ${response.status}). ${WHERE_TO_GET_ONE}`,
    );
  }

  const key = KEY_PATTERN.exec(response.body.toString("utf8"))?.[1]?.trim();
  if (!key) {
    throw new DipError(`No ApiKey found at ${sourceUrl}. ${WHERE_TO_GET_ONE}`);
  }

  if (options.verify === false) return { key, sourceUrl, verified: false };

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const check = await transport({
    method: "GET",
    url: `${baseUrl}/api/v1/vorgang`,
    headers: { Accept: "application/json", Authorization: `ApiKey ${key}`, "User-Agent": userAgent },
    ...timeout,
  });
  if (check.status === 401 || check.status === 403) {
    throw new DipError(
      `The key published at ${sourceUrl} is no longer accepted by DIP ` +
        `(HTTP ${check.status}). This source is known to lag. ${WHERE_TO_GET_ONE}`,
    );
  }
  if (check.status < 200 || check.status >= 300) {
    throw new DipError(
      `Could not verify the key against ${baseUrl} (HTTP ${check.status}). ` +
        `Re-run with --no-verify to print it unchecked, or see ${HELP_PAGE_URL}.`,
    );
  }
  return { key, sourceUrl, verified: true };
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(dip obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
