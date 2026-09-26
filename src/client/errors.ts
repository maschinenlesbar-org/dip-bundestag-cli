// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A URL without userinfo, or one that does not parse, is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
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
 * message extracted from the response body when one is present.
 */
export class DipApiError extends DipError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class DipNetworkError extends DipError {}

/**
 * A CLI usage error (bad/missing argument detected after commander parsing, e.g.
 * an empty `get <id>`). Mapped to the conventional usage exit code 2 so scripts
 * can distinguish it from a runtime error (1).
 */
export class DipUsageError extends DipError {}

/** The response body could not be parsed as the expected JSON shape. */
export class DipParseError extends DipError {}
