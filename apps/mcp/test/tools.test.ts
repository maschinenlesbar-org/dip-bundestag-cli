// This server's tools against a mock of DIP (the client's answers recorded live on 2026-11-20),
// with the skills' traps as cases: each tool answers through the protocol (its structuredContent
// checked by the SDK against its output schema); a title or a name with several matches is
// ambiguous, never picked; only a vote on the bill is a vote; a document's text comes in passages
// from the text endpoint, never from listing it; a refused key says what to check; every request
// carries the key and every result the Bundestag's terms. The rules every server follows are the
// conformance tests (M1–M11).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { keyHint } from "../src/mcp/tools.js";
import { KEY_SOURCE_URL } from "@maschinenlesbar.org/dip-bundestag-client/internal/obtain-key";
import { connect, recorder } from "./harness.js";
import { dipApi, jsonResponse, makeMockTransport, PERSON_1502, TEST_KEY } from "./helpers.js";

const API = "https://search.dip.bundestag.de/api/v1";
const pathOf = (call: { url: string }): string => new URL(call.url).pathname;

test("five tools: the three use cases first, then search and get", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["trackProcedure", "profileMember", "readDocument", "searchRecords", "getRecord"]);
});

test("trackProcedure by id: status, timeline, the votes on the bill only, the key sent, the Bundestag's terms", async () => {
  const upstream = dipApi();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("trackProcedure", { id: 298723 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal((content["procedure"] as { status: string }).status, "Verkündet");
  assert.equal(content["enacted"], true);
  assert.equal((content["timeline"] as unknown[]).length, 25);
  assert.deepEqual((content["votes"] as { step: string }[]).map((v) => v.step), ["2. Beratung", "3. Beratung"]);
  assert.equal(content["source"], `${API}/vorgang/298723`);
  assert.match(String(content["licence"]), /^Deutscher Bundestag, "Nutzungsbedingungen für DIP" \(27\.02\.2023\), custom terms.*Quelle: Deutscher Bundestag – DIP.*nutzungsbedingungen_dip\.pdf$/);
  assert.deepEqual(upstream.calls.map(pathOf), ["/api/v1/vorgang/298723", "/api/v1/vorgangsposition"]);
  assert.ok(upstream.calls.every((call) => call.headers?.["Authorization"] === `ApiKey ${TEST_KEY}`));
  await connection.close();
});

test("trackProcedure by title: several are ambiguous with the law first; the source names the endpoint, not the words", async () => {
  const connection = await connect({ transport: dipApi() });
  const content = (await connection.call("trackProcedure", { title: "Heizungsgesetz", electoralTerm: 20 })).structuredContent ?? {};
  assert.equal(content["status"], "ambiguous");
  assert.equal((content["candidates"] as { id: string }[])[0]?.id, "298723");
  assert.equal(content["total"], 8);
  assert.equal(content["source"], `${API}/vorgang`);
  await connection.close();
});

test("profileMember: a name with one match is the dossier; a common surname is ambiguous", async () => {
  const connection = await connect({ transport: dipApi() });
  const baerbock = (await connection.call("profileMember", { name: "Baerbock", electoralTerm: 21 })).structuredContent ?? {};
  assert.equal(baerbock["status"], "ok", JSON.stringify(baerbock).slice(0, 300));
  assert.deepEqual((baerbock["person"] as { parliamentaryGroups: string[] }).parliamentaryGroups, ["BÜNDNIS 90/DIE GRÜNEN"]);
  assert.deepEqual(baerbock["earlierRoles"], [{ terms: [20], ministry: "Auswärtiges Amt" }]);
  const schmidt = (await connection.call("profileMember", { name: "Schmidt", electoralTerm: 21 })).structuredContent ?? {};
  assert.equal(schmidt["status"], "ambiguous");
  assert.equal((schmidt["candidates"] as unknown[]).length, 9);
  await connection.close();
});

test("profileMember by id with activities: the person's record and the term's activities", async () => {
  const connection = await connect({ transport: dipApi() });
  const content = (await connection.call("profileMember", { id: 1502, activities: true })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal((content["activities"] as { total: number }).total, 2);
  assert.equal(content["source"], `${API}/person/1502`);
  await connection.close();
});

test("readDocument by number: metadata first, then the text endpoint by id; passages, the citation, nextOffset", async () => {
  const upstream = dipApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("readDocument", { number: "20/6875", limit: 3 })).structuredContent ?? {};
  assert.equal(content["status"], "ok", JSON.stringify(content).slice(0, 300));
  assert.equal((content["document"] as { cite: string }).cite, "BT-Drs. 20/6875");
  assert.equal((content["passages"] as unknown[]).length, 3);
  assert.equal(content["nextOffset"], 3);
  assert.equal(content["source"], `${API}/drucksache`);
  assert.deepEqual(upstream.calls.map(pathOf), ["/api/v1/drucksache", "/api/v1/drucksache-text/267686"]);
  await connection.close();
});

test("readDocument with find: only the passages that hold the word; a result over the cap keeps whole passages and says where to go on", async () => {
  const connection = await connect({ transport: dipApi(), config: { maxResultChars: 6000 } });
  const content = (await connection.call("readDocument", { id: 267686, find: "Wärmepumpe", limit: 40 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  const passages = content["passages"] as { index: number; text: string }[];
  assert.ok(passages.length > 0 && passages.every((p) => /wärmepumpe/i.test(p.text.replace(/\s+/g, " "))));
  assert.equal(content["source"], `${API}/drucksache-text/267686`);
  if (content["truncated"] === true) assert.equal(content["nextOffset"], passages.length);
  await connection.close();
});

test("searchRecords: DIP's filters, a bare date for f.aktualisiert sent as a date and time and said; an unknown filter refused", async () => {
  const upstream = dipApi();
  const connection = await connect({ transport: upstream });
  const content = (await connection.call("searchRecords", { resource: "drucksache", filters: { "f.titel": "Klimaschutz", "f.wahlperiode": 21, "f.aktualisiert.start": "2025-01-01" }, limit: 5 })).structuredContent ?? {};
  assert.equal(content["status"], "ok");
  assert.equal(content["total"], 33);
  assert.equal((content["records"] as unknown[]).length, 5);
  assert.equal(content["nextOffset"], 5);
  assert.equal(new URL(upstream.calls[0]!.url).searchParams.get("f.aktualisiert.start"), "2025-01-01T00:00:00");
  assert.match(String(content["note"]), /DIP wants a date and time/);
  const refused = await connection.call("searchRecords", { resource: "vorgang", filters: { "f.person": "Baerbock" } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /DIP ignores unknown filters/);
  await connection.close();
});

test("getRecord: one record; an unknown id is empty with what to do, not a bare not found", async () => {
  const connection = await connect({ transport: dipApi() });
  const ok = (await connection.call("getRecord", { resource: "person", id: 1502 })).structuredContent ?? {};
  assert.equal(ok["status"], "ok");
  assert.equal(ok["source"], `${API}/person/1502`);
  const none = (await connection.call("getRecord", { resource: "vorgang", id: 1 })).structuredContent ?? {};
  assert.equal(none["status"], "empty");
  assert.match(String(none["reason"]), /DIP has no vorgang with id 1/);
  await connection.close();
});

test("a refused key (401) from DIP_API_KEY says to replace or unset that key, not that a restart obtains a new one", async () => {
  const connection = await connect({ transport: makeMockTransport(() => jsonResponse({ code: 401, message: "Unauthorized" }, 401)) });
  const result = await connection.call("trackProcedure", { id: 298723 });
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /401.*DIP refused the API key in DIP_API_KEY.*replace it.*dip obtain-key.*or remove DIP_API_KEY.*restart/s);
  assert.doesNotMatch(text, /restart the server to obtain/);
  assert.ok(!text.includes(TEST_KEY));
  await connection.close();
});

test("a refused key (401) the server obtained says the public key is renewed and a restart obtains the current one", async () => {
  const key = "PubKey1.publishedCandidateTheApiAcceptsXXXXXXX";
  const upstream = makeMockTransport((request) => {
    if (request.url === KEY_SOURCE_URL) return jsonResponse({ content: `Der aktuell gültige API-Key lautet:<br />${key}` });
    // The verification at the lookup passes; the key is refused later (rotated while running).
    return new URL(request.url).pathname === "/api/v1/vorgang" ? jsonResponse({ numFound: 0, documents: [], cursor: "c" }) : jsonResponse({ code: 401, message: "Unauthorized" }, 401);
  });
  const connection = await connect({ transport: upstream, env: {} });
  const text = (await connection.call("getRecord", { resource: "person", id: 1502 })).content[0]?.text ?? "";
  assert.match(text, /401.*renews its public key.*restart the server to obtain the current one.*DIP_API_KEY/s);
  assert.ok(!text.includes(key));
  await connection.close();
});

test("a refused key (401) from the credentials file says to store the current one or remove it", () => {
  assert.match(keyHint("file"), /stored with `dip config`.*dip config set api-key.*dip obtain-key.*dip config unset api-key.*restart/s);
  assert.doesNotMatch(keyHint("file"), /restart the server to obtain/);
  assert.match(keyHint(undefined), /DIP refused the server's API key/);
});

test("without a key the published one is obtained and verified first: a candidate DIP refuses is never used", async () => {
  const stale = "OldKey1.staleCandidateTheApiRefusesNowXXXXXXXX";
  const current = "NewKey2.currentCandidateTheApiAcceptsYYYYYYYYY";
  const upstream = makeMockTransport((request) => {
    if (request.url === KEY_SOURCE_URL) return jsonResponse({ content: `Der aktuell gültige API-Key lautet:<br />${stale} (alt: ${current})` });
    const auth = request.headers?.["Authorization"];
    if (auth !== `ApiKey ${current}`) return jsonResponse({ code: 401, message: "Unauthorized" }, 401);
    return new URL(request.url).pathname === "/api/v1/vorgang" ? jsonResponse({ numFound: 0, documents: [], cursor: "c" }) : jsonResponse(PERSON_1502);
  });
  const { log, lines } = recorder();
  const connection = await connect({ transport: upstream, env: {}, log });
  const result = await connection.call("getRecord", { resource: "person", id: 1502 });
  assert.equal(result.structuredContent?.["status"], "ok", result.content[0]?.text);
  const api = upstream.calls.filter((call) => call.url !== KEY_SOURCE_URL);
  assert.deepEqual(api.map((call) => [pathOf(call), call.headers?.["Authorization"] === `ApiKey ${current}`]), [
    ["/api/v1/vorgang", false],
    ["/api/v1/vorgang", true],
    ["/api/v1/person/1502", true],
  ]);
  assert.match(lines.join("\n"), /INFO {2}\[dip-mcp\.config\] using the public API key obtained from https:\/\/content\.dip\.bundestag\.de\/\S+ and verified against the API/);
  assert.ok(!lines.join("\n").includes(current) && !lines.join("\n").includes(stale));
  await connection.close();
});
