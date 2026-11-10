// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { DipNetworkError, redactUrl, credentialsIn, redactCredentials, typedUrlCredentials } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Timeout for the whole request, response body included, in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
  /**
   * Always `"manual"` from the engine: a transport must not follow redirects but
   * return the 3xx as it came (`fetch(url, { redirect: req.redirect })`). The engine
   * follows them itself and decides per hop where credentials may go; a response
   * whose `url` shows the transport went to another origin is rejected.
   */
  redirect?: "manual";
  /**
   * Aborted when the engine's time limit (`timeoutMs`) passes. A transport should stop
   * the request then (`fetch(url, { signal })`); the engine rejects at the deadline
   * either way, and enforces `maxResponseBytes` on the body it gets back, so neither
   * limit depends on it.
   */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /**
   * The URL that answered, if the transport knows it (fetch's `response.url`). When it
   * is on another origin than the request's, the transport followed a redirect itself
   * and the engine fails the request (`DipNetworkError`).
   */
  url?: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** The message for a body over the size cap, naming the option on both sides. */
export function sizeLimitMessage(maxBytes: number): string {
  return `Response exceeded maxResponseBytes (${maxBytes} bytes; --max-response-bytes on the CLI)`;
}

/**
 * The longest delay Node's timers support (2^31 - 1 ms, about 24.8 days). A longer one
 * prints a TimeoutOverflowWarning and fires after 1 ms, so timeouts are capped here.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The message for a connection-level error, never empty. With a host name that
 * resolves to several addresses (`localhost` → ::1 and 127.0.0.1), Node >= 20 tries
 * each and reports the failure as an AggregateError whose own message is empty; the
 * reasons are in its `errors`. Falls back to the error code.
 */
export function describeNetworkError(err: Error): string {
  if (err.message.trim() !== "") return err.message;
  if (err instanceof AggregateError) {
    const inner = err.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e)));
    const messages = [...new Set(inner.filter((m) => m.trim() !== ""))];
    if (messages.length > 0) return messages.join("; ");
  }
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" && code !== "" ? code : "network error";
}

/** The most received chunks the default transport keeps unjoined. */
const COALESCE_CHUNKS = 1024;
/** The bytes of unjoined chunks at which the default transport joins them into one Buffer. */
const COALESCE_BYTES = 64 * 1024;

/**
 * `url` for a message, its userinfo redacted; one typed without its scheme (`user:pw@host`,
 * `TOKEN:@host`) or with a mistyped one (`http//user:pw@host`) is read as a URL all the same
 * (`typedUrlCredentials`), since `redactUrl` finds a userinfo only after a scheme.
 */
function shownUrl(url: string): string {
  return credentialsIn(url).length > 0 ? redactUrl(url) : redactCredentials(url, typedUrlCredentials(url));
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs). Small chunks of the body are joined as they
 * arrive (at most COALESCE_CHUNKS of them or COALESCE_BYTES unjoined), so the memory it keeps
 * follows the bytes of an answer, not the number of chunks a server sends.
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new DipNetworkError(`Invalid URL: ${shownUrl(request.url)}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // `user:password@host` without a scheme parses with the user name as the scheme: name a
      // scheme only when the value spells one (`<scheme>://`).
      const named = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(request.url) ? ` "${url.protocol}"` : "";
      reject(new DipNetworkError(`Unsupported protocol${named} in URL: ${shownUrl(request.url)}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // The timeout covers the whole exchange — connecting, waiting and reading the body.
    // A socket idle timeout alone would let a server that trickles a byte now and then
    // hold the request open indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const done = settle(resolve);
    const fail = settle(reject);

    const onResponse = (res: http.IncomingMessage): void => {
      // Small chunks are joined as they arrive (`pending`, at most COALESCE_CHUNKS of them or
      // COALESCE_BYTES), so the Buffers kept follow the bytes, not the number of chunks a server
      // chooses to send: a Buffer per one-byte chunk held ~210 bytes of heap each.
      const chunks: Buffer[] = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          res.destroy();
          fail(new DipNetworkError(sizeLimitMessage(maxBytes)));
          return;
        }
        pending.push(chunk);
        pendingBytes += chunk.length;
        if (pending.length >= COALESCE_CHUNKS || pendingBytes >= COALESCE_BYTES) {
          chunks.push(pending.length === 1 ? chunk : Buffer.concat(pending, pendingBytes));
          pending = [];
          pendingBytes = 0;
        }
      });
      res.on("end", () => {
        if (aborted) return;
        done({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat([...chunks, ...pending]),
        });
      });
      res.on("error", (err) => {
        if (aborted) return; // we already rejected with the size-cap error
        fail(new DipNetworkError(`Response stream error: ${err.message}`, { cause: err }));
      });
    };

    // driver.request throws synchronously for a header value Node cannot send (CR/LF,
    // a character above U+00FF); surface that as a typed error, not a raw TypeError.
    let req: http.ClientRequest;
    try {
      req = driver.request(url, { method: request.method, headers: request.headers }, onResponse);
    } catch (err) {
      fail(
        new DipNetworkError(`Invalid request: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        }),
      );
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = request.timeoutMs;
      timer = setTimeout(() => {
        const err = new DipNetworkError(`Request timed out after ${timeoutMs}ms`);
        fail(err);
        req.destroy(err);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
    }

    if (request.signal !== undefined) {
      const abort = (): void => {
        const reason = request.signal?.reason;
        const err = reason instanceof DipNetworkError ? reason : new DipNetworkError("Request aborted");
        fail(err);
        req.destroy(err);
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an DipNetworkError; don't double-wrap.
      fail(
        err instanceof DipNetworkError
          ? err
          : new DipNetworkError(describeNetworkError(err), { cause: err }),
      );
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
