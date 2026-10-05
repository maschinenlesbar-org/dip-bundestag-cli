// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo is returned unchanged; one that does not parse (a port
 * typo, an unencoded "#" in the password) has its userinfo cut out by text
 * (`credentialsIn`).
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that
 * don't parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`):
 * the userinfo is everything between `://` and the last `@` before the host. A value
 * without a scheme counts when it reads `user:password@host`. Used to redact those
 * exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before
  // the first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a
 * pattern, covers passwords with spaces, quotes, `#`, `?` or `/` that no URL
 * pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` with every occurrence of each secret (an API key, which has no `@` to
 * anchor on) replaced by `***`. Secrets shorter than 4 characters are skipped: they
 * are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/** Base class for every error originating from this client. */
export class DipError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present. For a 3xx that was
 * not followed (not a followable status, a missing or malformed Location, or past
 * `maxRedirects`), `location` holds the redirect target (absolute, sanitised,
 * userinfo redacted) and the message names it; after the redirect limit it also
 * says how many redirects were followed, so a loop reads as one.
 */
export class DipApiError extends DipError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;
  /**
   * Set when a redirect led to another origin, so the credentials (the API key, the
   * base URL's userinfo) were not sent to the server that answered. A 401/403 then
   * says nothing about the key; the message says what happened.
   */
  readonly credentialsDropped: { from: string; to: string } | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Set when the redirect limit stopped the request: the redirects followed. */
    redirectsFollowed?: number;
    /** Set when a redirect to another origin dropped the credentials. */
    credentialsDropped?: { from: string; to: string };
    /** Set when a 429/503 asked for a wait longer than the client retries after (ms). */
    retryAfterMs?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      const limit =
        args.redirectsFollowed !== undefined
          ? ` (stopped after ${args.redirectsFollowed} redirect${args.redirectsFollowed === 1 ? "" : "s"})`
          : "";
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed${limit}`
          : "redirect not followed (no Location header)",
      );
    }
    if (args.retryAfterMs !== undefined) {
      parts.push(
        `the server asked to wait ${Math.ceil(args.retryAfterMs / 1000)} s (Retry-After), longer than ` +
          `the 30 s the client waits, so it did not retry: retrying sooner won't help, try again later`,
      );
    }
    const dropped = args.credentialsDropped;
    if (dropped !== undefined && (args.status === 401 || args.status === 403)) {
      parts.push(credentialsDroppedHint(dropped));
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.credentialsDropped = dropped;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * Why a 401/403 after a cross-origin redirect is not about the credentials: they were
 * never sent to the server that answered. An http→https redirect on the same host gets
 * its own advice (use the https base URL), since that is the usual way to get here.
 */
export function credentialsDroppedHint(dropped: { from: string; to: string }): string {
  let from: URL | undefined;
  let to: URL | undefined;
  try {
    from = new URL(dropped.from);
    to = new URL(dropped.to);
  } catch {
    // fall through to the general text
  }
  if (from !== undefined && to !== undefined && from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname) {
    return (
      `the server redirected ${dropped.from} to ${dropped.to}, and the API key is not sent across ` +
      `a change of scheme, so the request arrived without it: use an https base URL (${dropped.to})`
    );
  }
  return (
    `the request was redirected from ${dropped.from} to ${dropped.to}, another origin, which ` +
    `does not get the API key or the base URL's credentials`
  );
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class DipNetworkError extends DipError {}

/**
 * A usage error: a bad or missing argument detected before any request (e.g.
 * `obtain-key --output`). Mapped to the conventional usage exit code 2 so
 * scripts can distinguish it from a runtime error (1).
 */
export class DipUsageError extends DipError {}

/**
 * The library rejected an input before sending any request (message
 * `Invalid <name>: <reason>`, see `validate.ts`). It extends `DipUsageError`, so
 * existing `instanceof DipUsageError` checks keep catching it, and the CLI maps
 * it to the usage exit code 2.
 */
export class DipValidationError extends DipUsageError {}

/** The response body could not be parsed as the expected JSON shape. */
export class DipParseError extends DipError {}
