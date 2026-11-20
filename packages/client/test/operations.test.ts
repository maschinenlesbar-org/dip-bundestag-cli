// The skills' use cases (src/operations.ts) against recorded answers (recorded.ts): each trap the
// skills document is a test here. No request reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DipClient } from "../src/client.js";
import { DipValidationError } from "../src/errors.js";
import { decisionKind, getRecord, listRecords, plainText, profileMember, readDocument, splitPassages, trackProcedure } from "../src/operations.js";
import type { Document, JsonObject, ListResult } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";
import {
  AKTIVITAETEN_1502_WP21,
  DRUCKSACHE_TEXT_267686,
  DRUCKSACHEN_20_6875,
  DRUCKSACHEN_KLIMASCHUTZ_WP21,
  PERSON_1502,
  PERSON_224,
  PERSONEN_BAERBOCK_WP21,
  PERSONEN_SCHMIDT_WP21,
  PLENARPROTOKOLLE_20_120,
  POSITIONEN_298723,
  VORGAENGE_HEIZUNGSGESETZ_WP20,
  VORGANG_298723,
} from "./recorded.js";

type Answer = (query: URLSearchParams) => unknown;

/** A mock of DIP: `routes` by the path under /api/v1 ("vorgang", "vorgang/298723"); anything else 404. */
function dip(routes: Record<string, Answer | unknown>): MockTransport {
  return makeMockTransport((request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const route = routes[path];
    if (route === undefined) return jsonResponse({ code: 404, message: "Not Found" }, 404);
    return jsonResponse(typeof route === "function" ? (route as Answer)(url.searchParams) : route);
  });
}

const client = (mock: MockTransport): DipClient => new DipClient({ transport: mock.transport, apiKey: "test-key-only" });
const query = (mock: MockTransport, i = 0): Record<string, string[]> => {
  const params = new URL(mock.calls[i]!.url).searchParams;
  const out: Record<string, string[]> = {};
  for (const [key, value] of params) (out[key] ??= []).push(value);
  return out;
};
const path = (mock: MockTransport, i = 0): string => new URL(mock.calls[i]!.url).pathname;
const list = (documents: JsonObject[], numFound = documents.length, cursor = "end"): ListResult => ({ numFound, documents, cursor });

// ---- trackProcedure

test("trackProcedure by id: the Vorgang and its steps joined with f.vorgang on the positions; enacted only from promulgation", async () => {
  const mock = dip({ "vorgang/298723": VORGANG_298723, vorgangsposition: POSITIONEN_298723 });
  const answer = await trackProcedure(client(mock), { id: " 298723 " });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(mock.calls.length, 2, "one numFound covers the page: no second request");
  assert.equal(path(mock, 1), "/api/v1/vorgangsposition");
  assert.deepEqual(query(mock, 1), { "f.vorgang": ["298723"] });
  assert.equal(answer.procedure.status, "Verkündet");
  assert.equal(answer.procedure.type, "Gesetzgebung");
  assert.equal(answer.enacted, true);
  assert.deepEqual(answer.promulgation, [{ reference: "BGBl I 2023, 280", date: "2023-10-19", pdfUrl: "https://www.recht.bund.de/eli/bund/BGBl_1/2023/280" }]);
  assert.equal(answer.inForce?.length, 2);
  assert.equal(answer.timeline.length, 25);
  assert.equal(answer.stepsTotal, 25);
  assert.equal(answer.complete, true);
  assert.doesNotMatch(answer.procedure.abstract ?? "", /<|&[a-z]+;/, "the abstract's HTML is removed");
});

test("trackProcedure: only the adoption in the 2./3. Beratung is a vote; referral, procedural motion, Bundesrat opinion and resolution are named as such", async () => {
  const answer = await trackProcedure(client(dip({ "vorgang/298723": VORGANG_298723, vorgangsposition: POSITIONEN_298723 })), { id: 298723 });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.deepEqual(
    answer.votes.map((v) => [v.date, v.step, v.text, v.method ?? "", v.result ?? ""]),
    [
      ["2023-09-08", "2. Beratung", "Annahme in Ausschussfassung", "", ""],
      ["2023-09-08", "3. Beratung", "Annahme in Ausschussfassung", "Namentliche Abstimmung", "397:275:5"],
    ],
  );
  const kinds = answer.timeline.flatMap((s) => (s.decisions ?? []).map((d) => `${s.chamber} ${s.step}: ${d.kind}`));
  assert.deepEqual(kinds, [
    "BR 1. Durchgang: opinion",
    "BT Geschäftsordnungsantrag auf Aufsetzung der 1. Beratung auf die TO: procedural",
    "BT 1. Beratung: referral",
    "BT Änderung der Ausschussüberweisung: referral",
    "BT Geschäftsordnungsantrag zur Beratung: procedural",
    "BT 2. Beratung: vote",
    "BT 2. Beratung: resolution",
    "BT 3. Beratung: vote",
    "BR 2. Durchgang: bundesrat",
  ]);
  assert.deepEqual(answer.leadCommittees, [
    { chamber: "BR", committee: "Ausschuss für Städtebau, Wohnungswesen und Raumordnung" },
    { chamber: "BT", committee: "Ausschuss für Klimaschutz und Energie" },
  ]);
});

test("trackProcedure: the timeline is sorted oldest first whatever DIP's order, chamber and document on each step", async () => {
  const shuffled = { ...POSITIONEN_298723, documents: [...POSITIONEN_298723.documents].reverse() };
  const answer = await trackProcedure(client(dip({ "vorgang/298723": VORGANG_298723, vorgangsposition: shuffled })), { id: "298723" });
  if (answer.status !== "ok") return assert.fail(answer.status);
  const dates = answer.timeline.map((s) => s.date ?? "");
  assert.deepEqual(dates, [...dates].sort());
  assert.deepEqual(answer.timeline[0], { ...answer.timeline[0], date: "2023-04-20", chamber: "BR", step: "Gesetzentwurf", document: "Drucksache 170/23" });
  const third = answer.timeline.find((s) => s.step === "3. Beratung");
  assert.equal(third?.document, "Plenarprotokoll 20/120");
});

test("trackProcedure: more steps than a page are read with the same filter on every cursor, and a page limit says the timeline is incomplete", async () => {
  const steps = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), vorgangsposition: "Schritt", datum: `2024-01-${String(1 + ((from + i) % 28)).padStart(2, "0")}`, zuordnung: "BT" }));
  const mock = dip({
    "vorgang/7": { id: "7", titel: "Test", beratungsstand: "Noch nicht beraten" },
    vorgangsposition: (q: URLSearchParams) => (q.get("cursor") === null ? list(steps(0, 100), 230, "c1") : q.get("cursor") === "c1" ? list(steps(100, 100), 230, "c2") : list(steps(200, 30), 230, "c3")),
  });
  const all = await trackProcedure(client(mock), { id: 7 });
  if (all.status !== "ok") return assert.fail(all.status);
  assert.equal(all.timeline.length, 230);
  assert.equal(all.complete, true);
  assert.deepEqual(query(mock, 2), { "f.vorgang": ["7"], cursor: ["c1"] });
  assert.deepEqual(query(mock, 3), { "f.vorgang": ["7"], cursor: ["c2"] });
  const capped = await trackProcedure(client(mock), { id: 7 }, { maxPages: 2 });
  if (capped.status !== "ok") return assert.fail(capped.status);
  assert.equal(capped.timeline.length, 200);
  assert.equal(capped.complete, false);
  assert.match(capped.note ?? "", /first 200 of 230 steps/);
});

test("trackProcedure by title: several are ambiguous, laws first, with the search scoped by term; never picked", async () => {
  const mock = dip({ vorgang: VORGAENGE_HEIZUNGSGESETZ_WP20 });
  const answer = await trackProcedure(client(mock), { title: " Heizungsgesetz ", electoralTerm: 20 });
  assert.equal(answer.status, "ambiguous");
  if (answer.status !== "ambiguous") return;
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(query(mock), { "f.titel": ["Heizungsgesetz"], "f.wahlperiode": ["20"] });
  assert.equal(answer.total, 8);
  assert.equal(answer.candidates[0]?.id, "298723");
  assert.equal(answer.candidates[0]?.type, "Gesetzgebung");
  assert.equal(answer.note, undefined);
});

test("trackProcedure by title: when only questions and motions match, the note says a law's popular name is often not in its title", async () => {
  const questions = VORGAENGE_HEIZUNGSGESETZ_WP20.documents.filter((d) => d["vorgangstyp"] !== "Gesetzgebung");
  const answer = await trackProcedure(client(dip({ vorgang: list(questions) })), { title: "Heizungsgesetz" });
  assert.equal(answer.status, "ambiguous");
  if (answer.status !== "ambiguous") return;
  assert.match(answer.note ?? "", /popular name is often not in its title.*type Gesetzgebung/);
});

test("trackProcedure by title: none is empty, saying f.titel matches whole words only; one is tracked", async () => {
  const none = await trackProcedure(client(dip({ vorgang: list([]) })), { title: "Gebäudeenergie", electoralTerm: 20, type: "Gesetzgebung" });
  assert.equal(none.status, "empty");
  if (none.status === "empty") assert.match(none.reason, /whole words of the title only.*"Gebäudeenergie" misses "Gebäudeenergiegesetzes"/);
  const law = VORGAENGE_HEIZUNGSGESETZ_WP20.documents.filter((d) => d["id"] === "298723");
  const mock = dip({ vorgang: list(law), "vorgang/298723": VORGANG_298723, vorgangsposition: POSITIONEN_298723 });
  const one = await trackProcedure(client(mock), { title: "Heizungsgesetz", type: "Gesetzgebung" });
  assert.equal(one.status, "ok");
  assert.deepEqual(query(mock, 0), { "f.titel": ["Heizungsgesetz"], "f.vorgangstyp": ["Gesetzgebung"] });
});

test("trackProcedure: an unknown id is empty, not an error; neither or both of id and title is a usage error before any request", async () => {
  const mock = dip({});
  const answer = await trackProcedure(client(mock), { id: "999999999" });
  assert.equal(answer.status, "empty");
  await assert.rejects(trackProcedure(client(mock), {}), DipValidationError);
  await assert.rejects(trackProcedure(client(mock), { id: 1, title: "x" }), DipValidationError);
  await assert.rejects(trackProcedure(client(mock), { id: "12a" }), /numeric DIP id/);
  assert.equal(mock.calls.length, 1);
});

test("decisionKind: the classification the tracker uses", () => {
  assert.equal(decisionKind("2./3. Beratung", "Ablehnung der Vorlage", "BT"), "vote");
  assert.equal(decisionKind("1. Beratung", "Annahme", "BT"), "other", "no vote on the bill in a 1. Beratung");
  assert.equal(decisionKind("2. Durchgang", "Zustimmung", "BR"), "bundesrat");
  assert.equal(decisionKind("3. Beratung", "Annahme Geschäftsordnungsantrag", "BT"), "procedural");
});

// ---- profileMember

test("profileMember by name: f.person with the term; the current function and Fraktion from the top level, earlier roles as ministry only", async () => {
  const mock = dip({ person: PERSONEN_BAERBOCK_WP21 });
  const answer = await profileMember(client(mock), { name: "Baerbock", electoralTerm: 21 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(query(mock), { "f.person": ["Baerbock"], "f.wahlperiode": ["21"] });
  assert.equal(answer.person.id, "1502");
  assert.equal(answer.person.name, "Annalena Baerbock");
  assert.deepEqual(answer.person.functions, ["MdB"]);
  assert.deepEqual(answer.person.parliamentaryGroups, ["BÜNDNIS 90/DIE GRÜNEN"]);
  assert.deepEqual(answer.earlierRoles, [{ terms: [20], ministry: "Auswärtiges Amt" }]);
  assert.match(answer.note, /role title is not in the record/);
  assert.match(answer.resolvedBy ?? "", /f\.person=Baerbock within electoral term 21/);
});

test("profileMember: a common surname is ambiguous with the candidates; a first name picks one; the same name twice stays ambiguous", async () => {
  const schmidt = () => dip({ person: PERSONEN_SCHMIDT_WP21 });
  const all = await profileMember(client(schmidt()), { name: "Schmidt", electoralTerm: 21 });
  assert.equal(all.status, "ambiguous");
  if (all.status === "ambiguous") assert.equal(all.candidates.length, 9);
  for (const name of ["Dagmar Schmidt", "Schmidt, Dagmar", "dagmar  SCHMIDT"]) {
    const mock = schmidt();
    const one = await profileMember(client(mock), { name, electoralTerm: 21 });
    assert.equal(one.status, "ok", name);
    if (one.status === "ok") assert.equal(one.person.id, "1607");
    assert.deepEqual(query(mock)["f.person"]?.map((v) => v.toLowerCase()), ["schmidt"], "the surname is sent: f.person matches complete names");
  }
  const twice = await profileMember(client(schmidt()), { name: "Jan Wenzel Schmidt", electoralTerm: 21 });
  assert.equal(twice.status, "ambiguous");
  if (twice.status === "ambiguous") assert.deepEqual(twice.candidates.map((c) => c.id).sort(), ["7406", "8220"]);
  const dr = await profileMember(client(schmidt()), { name: "Dr. Paul Schmidt", electoralTerm: 21 });
  assert.equal(dr.status, "ok", "an academic title is left out");
});

test("profileMember: a first name nobody of that surname has is empty with the candidates, not a guess", async () => {
  const answer = await profileMember(client(dip({ person: PERSONEN_SCHMIDT_WP21 })), { name: "Anna Schmidt", electoralTerm: 21 });
  assert.equal(answer.status, "empty");
  if (answer.status !== "empty") return;
  assert.match(answer.reason, /9 people are named Schmidt in term 21, none with every word of "Anna Schmidt"/);
  assert.equal(answer.candidates?.length, 9);
});

test("profileMember: a name f.person misses is looked for in the term's whole list, every page with the term filter", async () => {
  const people = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), vorname: "X", nachname: `Person${from + i}` }));
  const mock = dip({
    person: (q: URLSearchParams) => {
      if (q.get("f.person") !== null) return list([]);
      if (q.get("cursor") === null) return list(people(0, 100), 150, "c1");
      return list([...people(100, 49), { id: "4711", vorname: "Gülçin", nachname: "Müller-Lüdenscheidt", titel: "Gülçin Müller-Lüdenscheidt, MdB" }], 150, "c2");
    },
  });
  const answer = await profileMember(client(mock), { name: "Müller-Lüdenscheidt", electoralTerm: 21 });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.equal(answer.person.id, "4711");
  assert.match(answer.resolvedBy ?? "", /matched by name across 2 page\(s\) of electoral term 21/);
  assert.deepEqual(query(mock, 2), { "f.wahlperiode": ["21"], cursor: ["c1"] });
});

test("profileMember: nobody found without a term is empty, one request, and says f.person needs complete names and how to scan a term", async () => {
  const mock = dip({ person: list([]) });
  const answer = await profileMember(client(mock), { name: "Klöck" });
  assert.equal(answer.status, "empty");
  if (answer.status === "empty") assert.match(answer.reason, /complete first or last name \("Klöck" finds nothing\); give electoralTerm/);
  assert.equal(mock.calls.length, 1);
});

test("profileMember by id with activities: the latest term of the person when none is given, both filters sent, counted by kind", async () => {
  const mock = dip({ "person/1502": PERSON_1502, aktivitaet: AKTIVITAETEN_1502_WP21 });
  const answer = await profileMember(client(mock), { id: 1502, activities: true });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.deepEqual(query(mock, 1), { "f.person_id": ["1502"], "f.wahlperiode": ["21"] });
  assert.equal(answer.activities?.electoralTerm, 21);
  assert.equal(answer.activities?.total, 2);
  assert.equal(answer.activities?.items[0]?.document, "Plenarprotokoll 21/15");
  assert.equal(answer.activities?.items[0]?.procedure?.id, "322817");
  assert.equal(Object.values(answer.activities?.byKind ?? {}).reduce((a, b) => a + b, 0), 2);
});

test("profileMember: a minister has no Fraktion in DIP, and the note says why; an unknown id is empty", async () => {
  const minister = { ...PERSON_1502, funktion: ["Bundesmin."], fraktion: [], ressort: ["Auswärtiges Amt"] } as Document;
  const answer = await profileMember(client(dip({ "person/1502": minister })), { id: "1502" });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.match(answer.note, /No Fraktion: DIP gives one only for the function MdB/);
  assert.deepEqual(answer.person.ministries, ["Auswärtiges Amt"]);
  const unknown = await profileMember(client(dip({})), { id: "1" });
  assert.equal(unknown.status, "empty");
});

test("profileMember: a role the record names nothing for says so, rather than an empty entry", async () => {
  const answer = await profileMember(client(dip({ "person/224": PERSON_224 })), { id: 224 });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.deepEqual(answer.earlierRoles[0], { terms: [21], note: "The record names no ministry, Fraktion or office for this role: what it was is not in DIP's data." });
  assert.equal(answer.earlierRoles[1]?.ministry, "Bundesministerium für Ernährung und Landwirtschaft");
  assert.equal(answer.earlierRoles[1]?.note, undefined);
});

// ---- readDocument

test("readDocument by number: resolved on the metadata endpoint, then the text endpoint by id; never a list of the -text endpoint", async () => {
  const mock = dip({ drucksache: DRUCKSACHEN_20_6875, "drucksache-text/267686": DRUCKSACHE_TEXT_267686 });
  const answer = await readDocument(client(mock), { number: "20/6875" });
  assert.equal(answer.status, "ok");
  if (answer.status !== "ok") return;
  assert.deepEqual(mock.calls.map((c) => new URL(c.url).pathname), ["/api/v1/drucksache", "/api/v1/drucksache-text/267686"]);
  assert.deepEqual(query(mock), { "f.dokumentnummer": ["20/6875"] });
  assert.equal(answer.document.cite, "BT-Drs. 20/6875");
  assert.equal(answer.document.type, "Gesetzentwurf");
  assert.equal(answer.document.pdfUrl, "https://dserver.bundestag.de/btd/20/068/2006875.pdf");
  assert.deepEqual(answer.document.procedures?.map((p) => p.id), ["298723"]);
  assert.equal(answer.textLength, 12000);
  assert.equal(answer.passages.length, 8);
  assert.equal(answer.passages[0]?.index, 0);
  assert.ok(answer.passages[0]?.text.startsWith("[Deutscher Bundestag Drucksache 20/6875"));
  assert.equal(answer.nextOffset, 8);
  assert.match(answer.note ?? "", /extraction of the PDF/);
});

test("readDocument by id: the text endpoint at once; the passages are the text, verbatim, at most 1500 characters, cut at line ends", async () => {
  const mock = dip({ "drucksache-text/267686": DRUCKSACHE_TEXT_267686 });
  const answer = await readDocument(client(mock), { id: "267686", limit: 40 });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.equal(mock.calls.length, 1);
  assert.equal(answer.passages.map((p) => p.text).join(""), DRUCKSACHE_TEXT_267686["text"]);
  assert.equal(answer.totalPassages, answer.passages.length);
  assert.ok(answer.passages.every((p) => p.text.length <= 1500));
  assert.ok(answer.passages.slice(0, -1).every((p) => p.text.endsWith("\n")));
  assert.equal(answer.nextOffset, undefined);
});

test("readDocument by title: several are ambiguous, newest first, with the total; no text is read", async () => {
  const mock = dip({ drucksache: DRUCKSACHEN_KLIMASCHUTZ_WP21 });
  const answer = await readDocument(client(mock), { title: "Klimaschutz", electoralTerm: 21 });
  assert.equal(answer.status, "ambiguous");
  if (answer.status !== "ambiguous") return;
  assert.equal(mock.calls.length, 1);
  assert.equal(answer.total, 33);
  assert.equal(answer.candidates.length, 10);
  assert.equal(answer.complete, false);
  const dates = answer.candidates.map((c) => c.date ?? "");
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("readDocument with find: only the passages holding the words, their indexes kept, a word hyphenated at a line end found too", async () => {
  const answer = await readDocument(client(dip({ "drucksache-text/267686": DRUCKSACHE_TEXT_267686 })), { id: 267686, find: "wärmepumpe" });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.ok((answer.matches ?? 0) > 0);
  assert.ok(answer.passages.every((p) => /wärmepumpe/i.test(p.text.replace(/\s+/g, " "))));
  assert.ok(answer.passages.some((p) => p.index > 0));
  const text = `${"a ".repeat(800)}\nDas Gebäude-\nenergiegesetz gilt.\n${"b ".repeat(800)}\nKehr-  \nund Überprüfungsordnung\n`;
  const doc = { ...DRUCKSACHE_TEXT_267686, text };
  const hyphen = await readDocument(client(dip({ "drucksache-text/1": doc })), { id: 1, find: "Gebäudeenergiegesetz" });
  assert.equal(hyphen.status === "ok" && hyphen.matches, 1);
  const kept = await readDocument(client(dip({ "drucksache-text/1": doc })), { id: 1, find: "Kehr- und Überprüfungsordnung" });
  assert.equal(kept.status === "ok" && kept.matches, 1);
});

test("readDocument with find that matches nothing is empty with the document and what to try", async () => {
  const answer = await readDocument(client(dip({ "drucksache-text/267686": DRUCKSACHE_TEXT_267686 })), { id: 267686, find: "Tagesordnungspunkt 99" });
  assert.equal(answer.status, "empty");
  assert.ok("document" in answer && answer.document.cite === "BT-Drs. 20/6875");
  assert.match("reason" in answer ? (answer.reason ?? "") : "", /No passage of BT-Drs\. 20\/6875 holds/);
});

test("readDocument of a Plenarprotokoll: metadata by number, then its text; the note says it is the whole sitting", async () => {
  const sitting = { ...PLENARPROTOKOLLE_20_120.documents[0], text: "Beginn: 9.00 Uhr\nTagesordnungspunkt 1:\nGebäudeenergiegesetz\n" } as Document;
  const mock = dip({ plenarprotokoll: PLENARPROTOKOLLE_20_120, "plenarprotokoll-text/5590": sitting });
  const answer = await readDocument(client(mock), { kind: "plenarprotokoll", number: "20/120" });
  if (answer.status !== "ok") return assert.fail(answer.status);
  assert.deepEqual(mock.calls.map((c) => new URL(c.url).pathname), ["/api/v1/plenarprotokoll", "/api/v1/plenarprotokoll-text/5590"]);
  assert.equal(answer.document.cite, "BT-PlPr. 20/120");
  assert.match(answer.note ?? "", /whole sitting.*use find/);
});

test("readDocument: no extracted text points to the PDF; an unknown number says how numbers look; a wrong kind is refused", async () => {
  const bare = { ...DRUCKSACHE_TEXT_267686, text: "" };
  const answer = await readDocument(client(dip({ "drucksache-text/1": bare })), { id: 1 });
  assert.equal(answer.status, "ok");
  assert.match("note" in answer ? (answer.note ?? "") : "", /no extracted text.*read the PDF \(https:\/\/dserver/);
  const none = await readDocument(client(dip({ drucksache: list([]) })), { number: "20/99999" });
  assert.equal(none.status, "empty");
  assert.match("reason" in none ? (none.reason ?? "") : "", /term\/number \("20\/6875"\)/);
  await assert.rejects(readDocument(client(dip({})), { kind: "vorgang" as never, id: 1 }), DipValidationError);
});

test("splitPassages and plainText", () => {
  assert.deepEqual(splitPassages("ab\ncd\n", 3), ["ab\n", "cd\n"]);
  assert.deepEqual(splitPassages(`${"x".repeat(5)} ${"y".repeat(5)}`, 8), ["xxxxx ", "yyyyy"]);
  assert.deepEqual(splitPassages("z".repeat(10), 4), ["zzzz", "zzzz", "zz"]);
  assert.equal(plainText("<strong>Gesetz</strong> &quot;GEG&quot;<br />2023 &ndash; &auml;&#252;&#x00DF; &bogus;"), 'Gesetz "GEG"\n2023 – äüß &bogus;');
});

// ---- listRecords, getRecord

test("listRecords: f.aktualisiert wants a date and time, f.datum a date: both sent in DIP's form, and said", async () => {
  const mock = dip({ drucksache: list([{ id: "1", datum: "2026-11-02" }]) });
  const answer = await listRecords(client(mock), { resource: "drucksache", filters: { "f.aktualisiert.start": "2026-11-01", "f.datum.end": "2026-11-19T10:00:00Z", "f.wahlperiode": 21 } });
  assert.equal(answer.status, "ok");
  assert.deepEqual(query(mock), { "f.aktualisiert.start": ["2026-11-01T00:00:00"], "f.datum.end": ["2026-11-19"], "f.wahlperiode": ["21"] });
  assert.match(answer.note ?? "", /f\.aktualisiert\.start: DIP wants a date and time.*f\.datum\.end: DIP wants a calendar date/);
});

test("listRecords: an offset past the first page reads on with the same filters and the cursor; nextOffset says where to go on", async () => {
  const docs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }));
  const mock = dip({ vorgang: (q: URLSearchParams) => (q.get("cursor") === null ? list(docs(0, 100), 250, "c1") : list(docs(100, 100), 250, "c2")) });
  const answer = await listRecords(client(mock), { resource: "vorgang", filters: { "f.titel": "Klima" }, offset: 150, limit: 20 });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(query(mock, 1), { "f.titel": ["Klima"], cursor: ["c1"] });
  assert.equal(answer.records[0]?.["id"], "150");
  assert.equal(answer.records.length, 20);
  assert.equal(answer.nextOffset, 170);
  assert.equal(answer.total, 250);
});

test("listRecords: an unknown filter, a cursor, a -text resource and an offset past the page limit are refused before any request", async () => {
  const mock = dip({});
  await assert.rejects(listRecords(client(mock), { resource: "vorgang", filters: { "f.person": "Baerbock" } }), /DIP ignores unknown filters/);
  await assert.rejects(listRecords(client(mock), { resource: "vorgang", filters: { cursor: "x" } }), /not a cursor/);
  await assert.rejects(listRecords(client(mock), { resource: "drucksache-text" as never }), /readDocument/);
  await assert.rejects(listRecords(client(mock), { resource: "vorgang", offset: 990, limit: 20 }), /at most 1000/);
  assert.equal(mock.calls.length, 0);
});

test("listRecords: nothing found is empty with a reason; an unfiltered list pages on purpose", async () => {
  const none = await listRecords(client(dip({ person: list([], 0) })), { resource: "person", filters: { "f.person": "Nobody" } });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /No record matches/);
  const docs = (from: number) => Array.from({ length: 100 }, (_, i) => ({ id: String(from + i) }));
  const mock = dip({ person: (q: URLSearchParams) => list(docs(q.get("cursor") === null ? 0 : 100), 5000, q.get("cursor") === null ? "c1" : "c2") });
  const page2 = await listRecords(client(mock), { resource: "person", offset: 100, limit: 5 });
  assert.equal(page2.records[0]?.["id"], "100");
  assert.deepEqual(query(mock, 1), { cursor: ["c1"] });
});

test("getRecord: one record; an unknown id is empty with what to do", async () => {
  const ok = await getRecord(client(dip({ "person/1502": PERSON_1502 })), "person", "1502");
  assert.equal(ok.status, "ok");
  const none = await getRecord(client(dip({})), "vorgang", 5);
  assert.equal(none.status, "empty");
  if (none.status === "empty") assert.match(none.reason, /DIP has no vorgang with id 5/);
});
