// Test helpers of this server's own tests and the adapters of the conformance tests: a mock of the
// DIP API on its own paths (`/api/v1/<resource>` and `/api/v1/<resource>/<id>`) answering with the
// client's recorded answers (recorded.ts, live on 2026-11-20), and the client's transport helpers.
// The generic harness (a connection, a config, a log recorder, the HTTP server) is harness.ts; it
// gives the server TEST_ENV, so no test reads a credentials file or obtains a key.

import { jsonResponse, makeMockTransport, type MockTransport } from "@maschinenlesbar.org/dip-bundestag-client/test/helpers";
import {
  AKTIVITAETEN_1502_WP21,
  DRUCKSACHE_TEXT_267686,
  DRUCKSACHEN_20_6875,
  DRUCKSACHEN_KLIMASCHUTZ_WP21,
  PERSON_1502,
  PERSONEN_BAERBOCK_WP21,
  PERSONEN_SCHMIDT_WP21,
  PLENARPROTOKOLLE_20_120,
  POSITIONEN_298723,
  VORGAENGE_HEIZUNGSGESETZ_WP20,
  VORGANG_298723,
} from "@maschinenlesbar.org/dip-bundestag-client/test/recorded";

export * from "@maschinenlesbar.org/dip-bundestag-client/test/helpers";
export * from "@maschinenlesbar.org/dip-bundestag-client/test/recorded";

/** The test key the server finds in its environment (harness.ts); never a real one. */
export const TEST_KEY = "test-key-only";

/** The environment every server of these tests sees, unless a test passes its own. */
export const TEST_ENV: Record<string, string> = { DIP_API_KEY: TEST_KEY };

/** An answer by the query, or a fixed one. */
export type Route = unknown | ((query: URLSearchParams) => unknown);

/** The recorded answers by path under /api/v1 (lists by their filter where several were recorded). */
export const RECORDED_ROUTES: Record<string, Route> = {
  "vorgang/298723": VORGANG_298723,
  vorgangsposition: POSITIONEN_298723,
  vorgang: VORGAENGE_HEIZUNGSGESETZ_WP20,
  person: (q: URLSearchParams) => (q.get("f.person")?.toLowerCase() === "schmidt" ? PERSONEN_SCHMIDT_WP21 : PERSONEN_BAERBOCK_WP21),
  "person/1502": PERSON_1502,
  aktivitaet: AKTIVITAETEN_1502_WP21,
  drucksache: (q: URLSearchParams) => (q.get("f.dokumentnummer") !== null ? DRUCKSACHEN_20_6875 : DRUCKSACHEN_KLIMASCHUTZ_WP21),
  "drucksache-text/267686": DRUCKSACHE_TEXT_267686,
  plenarprotokoll: PLENARPROTOKOLLE_20_120,
};

/** DIP: `routes` by the path under /api/v1 (default: the recorded answers); anything else 404 as DIP answers it. */
export function dipApi(routes: Record<string, Route> = RECORDED_ROUTES): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const route = routes[path];
    if (route === undefined) return jsonResponse({ code: 404, message: "Not Found" }, 404);
    return jsonResponse(typeof route === "function" ? (route as (q: URLSearchParams) => unknown)(url.searchParams) : route);
  });
}
