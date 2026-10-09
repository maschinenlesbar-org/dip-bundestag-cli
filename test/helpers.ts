// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import type { CliDeps } from "../src/cli/io.js";
import { defaultDeps } from "../src/cli/program.js";
import { run } from "../src/cli/run.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [dip.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
}

// ---- CLI <-> library parity ---------------------------------------------------

/** What one side of a parity run did: its outcome and the requests it sent. */
export interface ParitySide {
  /** Requests this side sent, in order. */
  requests: HttpRequest[];
}

export interface CliOutcome extends ParitySide {
  code: number;
  out: string;
  err: string;
}

export type LibOutcome = ParitySide &
  ({ ok: true; value: unknown } | { ok: false; error: unknown });

export interface ParityResult {
  cli: CliOutcome;
  lib: LibOutcome;
}

export interface ParityInput {
  /** argv for run() (without the `node dip` prefix). */
  argv: string[];
  /** The library call, on a transport shared with the CLI run. */
  lib: (transport: Transport) => unknown;
  /** The CLI's environment (default: empty, so no real DIP_API_KEY leaks in). */
  env?: Record<string, string | undefined>;
  /** Answers every request on both sides (default: an empty list envelope). */
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;
}

/**
 * Send one input through the CLI (`run()`, its client built by the real
 * `createClient` and `obtain-key`'s `deps.transport`, both on one recording mock
 * transport) and through a library call on that same transport, and return both
 * outcomes with the requests each side sent. A parity test then asserts the same
 * outcome: both reject and neither sends a request, or both send the identical
 * request (see `requestKey`).
 */
export async function parity(input: ParityInput): Promise<ParityResult> {
  const mt = makeMockTransport(
    input.responder ?? (() => jsonResponse({ numFound: 0, documents: [] })),
  );
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Buffer>();
  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      writeFile: (p, d) => files.set(p, d),
      outBinary: (d) => out.push(d.toString("utf8")),
    },
    createClient: (opts) => defaultDeps.createClient({ ...opts, transport: mt.transport }),
    env: input.env ?? {},
    transport: mt.transport,
  };
  const code = await run(input.argv, deps);
  const cliRequests = mt.calls.splice(0);

  let lib: LibOutcome;
  try {
    const value = await input.lib(mt.transport);
    lib = { ok: true, value, requests: mt.calls.splice(0) };
  } catch (error) {
    lib = { ok: false, error, requests: mt.calls.splice(0) };
  }
  return { cli: { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliRequests }, lib };
}

/** A comparable summary of a request: method, URL, Authorization and User-Agent. */
export function requestKey(req: HttpRequest): string {
  const h = (name: string): string => req.headers?.[name] ?? "-";
  return `${req.method} ${req.url} auth:${h("Authorization")} ua:${h("User-Agent")}`;
}
