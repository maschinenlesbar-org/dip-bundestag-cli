// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
import type { CliDeps } from "../src/cli/io.js";
import { defaultDeps } from "../src/cli/program.js";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/dip-bundestag-client/test/helpers";

export * from "@maschinenlesbar.org/dip-bundestag-client/test/helpers";

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
