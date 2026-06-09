import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient } from "../src/client/client.js";
import { DipApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>, apiKey?: string): DipClient {
  return new DipClient({ transport: mt.transport, ...(apiKey ? { apiKey } : {}) });
}

const API = "/api/v1";

test("list sends Authorization: ApiKey and the resource path when a key is set", async () => {
  const mt = constantJson({ numFound: 0, documents: [] });
  await clientWith(mt, "test-key").vorgaenge.list({ "f.titel": "Klima" });
  const req = mt.last();
  assert.equal(req.headers?.["Authorization"], "ApiKey test-key");
  const url = new URL(req.url);
  assert.equal(url.pathname, `${API}/vorgang`);
  assert.equal(url.searchParams.get("f.titel"), "Klima");
});

test("no Authorization header is sent when no key is supplied (no bundled default)", async () => {
  const mt = constantJson({ numFound: 0, documents: [] });
  await clientWith(mt).vorgaenge.list();
  assert.equal(mt.last().headers?.["Authorization"], undefined);
});

test("a custom apiKey sets the Authorization header", async () => {
  const mt = constantJson({ numFound: 0, documents: [] });
  await clientWith(mt, "MYKEY").drucksachen.list();
  assert.equal(mt.last().headers?.["Authorization"], "ApiKey MYKEY");
});

test("each resource maps to its own path", async () => {
  const mt = constantJson({ numFound: 0, documents: [] });
  const c = clientWith(mt);
  await c.plenarprotokollText.list();
  assert.equal(new URL(mt.last().url).pathname, `${API}/plenarprotokoll-text`);
  await c.personen.list();
  assert.equal(new URL(mt.last().url).pathname, `${API}/person`);
});

test("get builds the per-id path", async () => {
  const mt = constantJson({ id: "1" });
  await clientWith(mt).drucksachen.get("123456");
  assert.equal(new URL(mt.last().url).pathname, `${API}/drucksache/123456`);
});

test("a 401 raises DipApiError with status 401", async () => {
  const mt = makeMockTransport(() => jsonResponse({ code: 401, message: "key required" }, 401));
  await assert.rejects(
    () => clientWith(mt).vorgaenge.list(),
    (err) => err instanceof DipApiError && err.status === 401,
  );
});
