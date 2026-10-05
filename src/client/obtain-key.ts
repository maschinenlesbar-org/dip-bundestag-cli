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

import { API_PATH, DEFAULT_BASE_URL, RequestEngine, type EngineOptions, type RawResponse } from "./engine.js";
import { DipApiError, DipError, credentialsIn, redactCredentials, redactUrl } from "./errors.js";

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
 * True when `value` (as a whole) has the shape of a DIP key: a 6–12 character
 * prefix, a dot, a 30–48 character body, from `A–Z a–z 0–9 _ -`. The CLI uses it to
 * keep a key typed in the wrong place (`dip <key> vorgang list`) out of its messages.
 */
export function looksLikeApiKey(value: string): boolean {
  return new RegExp(`^${KEY_TOKEN}$`).test(value.trim());
}

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

/**
 * Options for `obtainKey`. The request options are the API client's
 * (`EngineOptions`), with the same defaults and the same checks: `timeoutMs`
 * (default 30 s, 0 disables), `maxResponseBytes` (default 100 MiB, 0 disables),
 * `maxRetries` (429/503 retries, default 2), `retryDelayMs`, `maxRedirects`
 * (default 5) and `userAgent` (default `DEFAULT_USER_AGENT`).
 */
export interface ObtainKeyOptions
  extends Pick<
    EngineOptions,
    | "transport"
    | "timeoutMs"
    | "maxResponseBytes"
    | "userAgent"
    | "maxRetries"
    | "retryDelayMs"
    | "maxRedirects"
    | "sleep"
  > {
  /** Pin a single source document (tests, mirrors) instead of trying each in turn. */
  sourceUrl?: string;
  /** API base URL used for the verification request; checked like the client's. */
  baseUrl?: string;
  /** Check the candidate against the live API before returning it (default true). */
  verify?: boolean;
}

export interface ObtainedKey {
  /** The key, ready to put in `API_KEY_ENV_VAR`. */
  key: string;
  /** Which source it came from, so callers can cite it (userinfo shown as `***@`). */
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
  // Every request goes through the API client's engine: the same timeout and
  // size cap (a source or API host that stalls, or streams without end, must not
  // hang the command), 429/503 retry with Retry-After, redirect following with
  // cross-origin credential stripping, and the same checks on the options (base
  // URL, User-Agent, limits) before any request. No key is set on the engine;
  // each verification request carries its candidate.
  const engine = new RequestEngine({
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxResponseBytes !== undefined ? { maxResponseBytes: options.maxResponseBytes } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });
  const verify = options.verify !== false;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  // Why each source failed, in order, so the final error can say what was tried.
  const failures: string[] = [];

  for (const rawSourceUrl of sources) {
    // A source behind Basic auth (a private mirror) is named without its userinfo, in
    // the error and in the result, and its credentials are cut from transport text.
    const sourceUrl = redactUrl(rawSourceUrl);
    const sourceCredentials = credentialsIn(rawSourceUrl);
    let document: string;
    try {
      const response = await engine.getAbsolute(rawSourceUrl, {
        accept: "application/json, text/plain, text/markdown;q=0.9, */*;q=0.8",
      });
      document = response.data.toString("utf8");
    } catch (err) {
      // A non-2xx status (after retries and redirects), or unreachable (DNS,
      // reset, timeout, size cap): either way, try the next source.
      const reason = err instanceof DipApiError ? `HTTP ${err.status}` : describeError(err);
      failures.push(`${sourceUrl} could not be read (${redactCredentials(reason, sourceCredentials)})`);
      continue;
    }

    const candidates = extractKeyCandidates(document);
    if (candidates.length === 0) {
      failures.push(`${sourceUrl} states no key`);
      continue;
    }
    if (!verify) return { key: candidates[0] as string, sourceUrl, verified: false };

    let rejected = 0;
    for (const key of candidates) {
      let response: RawResponse;
      try {
        response = await engine.request("GET", `${API_PATH}/vorgang`, {
          accept: "application/json",
          headers: { Authorization: `ApiKey ${key}` },
        });
      } catch (err) {
        // A 401/403 from the origin that received the key rejects it: try the next one.
        if (
          err instanceof DipApiError &&
          (err.status === 401 || err.status === 403) &&
          err.credentialsDropped === undefined
        ) {
          rejected += 1;
          continue;
        }
        // Not an authentication verdict: the API host is unreachable or unwell, or a
        // redirect took the request to another origin, which never saw the key. Stop
        // rather than blame the key or walk the remaining candidates.
        const reason =
          err instanceof DipApiError
            ? err.credentialsDropped !== undefined
              ? `HTTP ${err.status} from ${err.credentialsDropped.to}, another origin, which did not receive the key`
              : `HTTP ${err.status}`
            : describeError(err);
        throw new DipError(
          `Could not verify the key against ${redactUrl(baseUrl)} (${reason}). ` +
            `Re-run with --no-verify to print it unchecked, or see ${HELP_PAGE_URL}.`,
          err instanceof DipApiError ? {} : { cause: err },
        );
      }
      // Only an answer from the origin that received the key verifies it: after a
      // redirect to another origin the key was (rightly) withheld, so that server's
      // 200 says nothing about the key.
      if (response.credentialsDropped !== undefined) {
        throw new DipError(
          `Could not verify the key against ${redactUrl(baseUrl)} (redirected to ` +
            `${response.credentialsDropped.to}, another origin, which did not receive the key). ` +
            `Re-run with --no-verify to print it unchecked, or see ${HELP_PAGE_URL}.`,
        );
      }
      return { key, sourceUrl, verified: true };
    }
    failures.push(
      `the key${rejected > 1 ? "s" : ""} published at ${sourceUrl} ` +
        `${rejected > 1 ? "are" : "is"} no longer accepted by DIP (HTTP 401)`,
    );
  }

  throw new DipError(`No usable DIP key: ${failures.join("; ")}. ${WHERE_TO_GET_ONE}`);
}

/** A transport failure's message for the error text (never empty). */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "network error";
}

/**
 * Quote a value for safe use inside a POSIX `export VAR=...` line, so
 * `eval "$(dip obtain-key --export)"` cannot execute anything the source
 * document smuggled in.
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
