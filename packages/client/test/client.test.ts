import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient } from "../src/client.js";
import { DipApiError, DipValidationError } from "../src/errors.js";
import { TEXT_FILTERS } from "../src/filters.js";
import { normalizeText } from "../src/validate.js";
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

test("an id of . or .. is rejected before any request instead of re-targeting the URL", async () => {
  for (const id of [".", ".."]) {
    const mt = constantJson({ numFound: 0, documents: [] });
    await assert.rejects(
      () => clientWith(mt).vorgaenge.get(id),
      (err: unknown) =>
        err instanceof DipValidationError &&
        err.message === `Invalid vorgang id: "." and ".." cannot be used as an id.`,
    );
    assert.equal(mt.calls.length, 0);
  }
  // An id with a "/" went out as %2F (`vorgang/a1%2F..%2Fa2`), which a server or proxy that
  // decodes it reads as more path segments (P24, kit rollout 2026-10-21). No DIP id has one.
  for (const id of ["a1/../a2", "a1/", "/a1", " 1/2 "]) {
    const mt = constantJson({ id: "x" });
    await assert.rejects(
      () => clientWith(mt).vorgaenge.get(id),
      (err: unknown) => err instanceof DipValidationError && err.message === 'Invalid vorgang id: An id cannot contain "/".',
      id,
    );
    assert.equal(mt.calls.length, 0, id);
  }
  // Longer dot runs and percent forms are ordinary ids.
  const mt = constantJson({ id: "x" });
  await clientWith(mt).vorgaenge.get("...");
  await clientWith(mt).vorgaenge.get("%2e%2e");
  assert.deepEqual(
    mt.calls.map((c) => new URL(c.url).pathname),
    [`${API}/vorgang/...`, `${API}/vorgang/%252e%252e`],
  );
});

test("the apiKey is sent trimmed", async () => {
  const mt = constantJson({ numFound: 0, documents: [] });
  await clientWith(mt, "  abc  ").vorgaenge.list();
  assert.equal(mt.last().headers?.["Authorization"], "ApiKey abc");
});

test("an apiKey an HTTP header cannot carry is a DipValidationError at construction", () => {
  for (const apiKey of ["a\nb", "k\r\nX-Evil: 1", "a\u0000b", "schl\u00fcssel\u20ac"]) {
    assert.throws(
      () => new DipClient({ apiKey }),
      (err: unknown) =>
        err instanceof DipValidationError &&
        /^Invalid apiKey: Value contains (control characters|characters outside Latin-1)/.test(err.message),
      JSON.stringify(apiKey),
    );
  }
});

test("a filter value in decomposed Unicode is sent composed (NFC); the cursor is left alone", async () => {
  // DIP matches composed text only: f.titel=Bürgergeld with U+0308 counted 0 where the composed
  // form counted 139, f.person=Müller 0 where it counted 60 (exploratory 2026-10-15, bug 8).
  const mt = makeMockTransport(() => jsonResponse({ numFound: 0, documents: [], cursor: "*" }));
  const client = clientWith(mt, "k");
  await client.vorgaenge.list({ "f.titel": ["Bürgergeld", "Klima"], "f.wahlperiode": 20, cursor: "Aöx" });
  const query = new URL(mt.calls[0]!.url).searchParams;
  assert.deepEqual(query.getAll("f.titel"), ["Bürgergeld", "Klima"]);
  assert.equal(query.get("f.wahlperiode"), "20");
  assert.equal(query.get("cursor"), "Aöx", "a cursor is opaque and sent as given");
  await client.personen.list({ "f.person": "Müller" });
  assert.equal(new URL(mt.calls[1]!.url).searchParams.get("f.person"), "Müller");
});

test("a text filter goes out trimmed and composed; codes and dates are left as given (kit rollout 2026-10-21, K6)", async () => {
  // `--filter "f.titel= Klima"` (or a value pasted with a trailing newline) went out with the
  // space and matched nothing. Codes, dates and the cursor are not text the API matches.
  const mt = makeMockTransport(() => jsonResponse({ numFound: 0, documents: [], cursor: "*" }));
  const client = clientWith(mt, "k");
  await client.vorgaenge.list({
    "f.titel": ["  Bu\u0308rgergeld\n", "\tKlima  schutz "],
    "f.urheber": " Bundesregierung ",
    "f.dokumentnummer": " 20/1234",
    "f.datum.start": "2024-01-01 ",
    cursor: " Aöx ",
  });
  const query = new URL(mt.calls[0]!.url).searchParams;
  assert.deepEqual(query.getAll("f.titel"), ["Bürgergeld", "Klima  schutz"]);
  assert.equal(query.get("f.urheber"), "Bundesregierung");
  assert.equal(query.get("f.dokumentnummer"), " 20/1234", "a code is sent as given");
  assert.equal(query.get("f.datum.start"), "2024-01-01 ", "a date is sent as given");
  assert.equal(query.get("cursor"), " Aöx ", "a cursor is opaque");
  await client.personen.list({ "f.person": "　Müller " });
  assert.equal(new URL(mt.calls[1]!.url).searchParams.get("f.person"), "Müller");
  assert.equal(normalizeText(" Mu\u0308ller\n"), "Müller");
  assert.ok(TEXT_FILTERS.includes("f.titel") && !TEXT_FILTERS.includes("f.dokumentnummer"));
});

test("an integer filter loses its leading zeros: DIP compares ids as text (bug 9, 2026-10-15)", async () => {
  // `--id 0282486` and `f.vorgang=0282486` passed the digits check and found nothing, exit 0,
  // where 282486 found the procedure.
  const mt = makeMockTransport(() => jsonResponse({ numFound: 0, documents: [], cursor: "*" }));
  const client = clientWith(mt, "k");
  await client.vorgaenge.list({ "f.id": ["0282486", "000", "0", 7], "f.wahlperiode": "020", "f.titel": "007" });
  const query = new URL(mt.calls[0]!.url).searchParams;
  assert.deepEqual(query.getAll("f.id"), ["282486", "0", "0", "7"]);
  assert.equal(query.get("f.wahlperiode"), "20");
  assert.equal(query.get("f.titel"), "007", "a text filter keeps its digits as typed");
  await client.vorgangspositionen.list({ "f.vorgang": "0282486" });
  assert.equal(new URL(mt.calls[1]!.url).searchParams.get("f.vorgang"), "282486");
});

test("an API key with whitespace inside is refused, like the credentials file refuses it (bug 1, 2026-10-15)", () => {
  // A tab or space inside a pasted key went out as `ApiKey Tab\t.key…` and ended in a 401.
  for (const key of ["TabKeyA\t.tabtabtabtabtabtabtabtabtabtabtab", "Inner Key.spacespacespacespacespacespacespa", "a b"]) {
    assert.throws(() => new DipClient({ apiKey: key }), (err) => {
      assert.ok(err instanceof DipValidationError, JSON.stringify(key));
      assert.doesNotMatch(err.message, /tabtab|spacespace/, "the key is never repeated");
      return true;
    });
  }
  // Surrounding whitespace is still trimmed, and a blank key still means none.
  assert.doesNotThrow(() => new DipClient({ apiKey: "  Trimmed.trimtrimtrimtrimtrimtrimtrimtrimtr \t" }));
  assert.doesNotThrow(() => new DipClient({ apiKey: "   " }));
});
