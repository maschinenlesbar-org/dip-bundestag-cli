// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's tools, a library user) has to know them. The client's requests take no signal of
// their own; a caller that needs to cancel passes one through its transport (the MCP server
// does).
//
// - trackProcedure (dip-procedure-tracker): a Vorgang by id or title words, its steps
//   (Vorgangspositionen, joined by `f.vorgang` on the positions, every page) as a chronological
//   timeline, each decision named for what it is: only a vote on the bill in the 2./3. Beratung
//   (or on the mediation committee's proposal) is a vote; a referral, a procedural motion, a Bundesrat opinion or a resolution is not.
// - profileMember (dip-member-dossier): a person by id or name (`f.person` matches complete
//   names only), the current function and Fraktion from the top level, the earlier roles from
//   `person_roles` (no role title there), optionally the activities of a term.
// - readDocument (dip-document-digest): a Drucksache or Plenarprotokoll by id, number or title
//   words, resolved on the light metadata endpoint, then its full text from the heavy `-text`
//   endpoint in passages, or only the passages that hold a word (a sitting's protocol is the
//   whole day).
// - listRecords and getRecord: any metadata resource with DIP's filters, read in DIP's pages of
//   100 behind an offset, the date filters in the form DIP accepts.
//
// Ambiguity is reported, never guessed: several matches are `ambiguous`, with the candidates.
// No bare "not found": an empty answer says what was searched and what to change.

import type { DipClient } from "./client.js";
import { DipApiError, DipValidationError } from "./errors.js";
import { LIST_FILTERS, type ListResource } from "./filters.js";
import type { QueryParams, QueryPrimitive } from "./query.js";
import type { JsonObject, ListResult } from "./types.js";
import { assertValid, isBlank, normalizeText, textProblem } from "./validate.js";

/** DIP's page size: every list answer holds at most this many documents. */
export const DIP_PAGE_SIZE = 100;

/** The pages an operation reads per list unless told otherwise (`maxPages`). */
export const DEFAULT_MAX_PAGES = 10;

/** Options of the operations that read lists. */
export interface OperationOptions {
  /** The most pages (100 documents each) read per list and call (default 10). */
  maxPages?: number | undefined;
}

/** The metadata resources the generic operations read (the `-text` ones only through readDocument). */
export const RECORD_RESOURCES = ["vorgang", "vorgangsposition", "drucksache", "plenarprotokoll", "aktivitaet", "person"] as const;
export type RecordResource = (typeof RECORD_RESOURCES)[number];

/** The client's resource group for a resource's path segment. */
function group(client: DipClient, resource: ListResource) {
  switch (resource) {
    case "vorgang":
      return client.vorgaenge;
    case "vorgangsposition":
      return client.vorgangspositionen;
    case "drucksache":
      return client.drucksachen;
    case "drucksache-text":
      return client.drucksacheText;
    case "plenarprotokoll":
      return client.plenarprotokolle;
    case "plenarprotokoll-text":
      return client.plenarprotokollText;
    case "aktivitaet":
      return client.aktivitaeten;
    case "person":
      return client.personen;
  }
}

/** The documents of a filtered list, page after page with the same filters, up to `maxPages`. */
interface Collected {
  total: number;
  documents: JsonObject[];
  /** True when every matching document was read. */
  complete: boolean;
  pages: number;
  /** True when DIP answered a page of documents already read (under a new cursor): the reading stopped there. */
  repeated: boolean;
}

/** Why a list was read only in part, for a note: the page limit or a page DIP repeated. */
function partly(read: Collected): string {
  return read.repeated ? "DIP repeated a page of documents already read, under a new cursor, and the reading stopped there" : "page limit";
}

/**
 * Read `want` documents (default: all) of a list, sending the same filters with every cursor:
 * DIP doesn't bind a cursor to its query, so a cursor alone pages through the whole unfiltered
 * collection. Stops when `numFound` is reached, a page is empty, the cursor stops changing (DIP's
 * last page), a page holds only documents already read (DIP repeating itself under a new cursor:
 * `repeated`, and the list is not complete), or after `maxPages` pages. A document already read
 * (by its id) is not taken twice.
 */
async function collect(client: DipClient, resource: ListResource, filters: QueryParams, maxPages: number, want = Number.POSITIVE_INFINITY): Promise<Collected> {
  const list = group(client, resource);
  // An unfiltered list is paged on purpose: the bare cursor is then what the caller asked for.
  const unfiltered = Object.values(filters).every((value) => value === undefined || value === null);
  const documents: JsonObject[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cursor: string | undefined;
  let pages = 0;
  let repeated = false;
  while (pages < maxPages) {
    const page: ListResult = await list.list(cursor === undefined ? filters : { ...filters, cursor }, { allowUnfilteredCursor: unfiltered });
    pages += 1;
    total = page.numFound;
    const fresh = page.documents.filter((doc) => {
      const id = doc["id"];
      if (typeof id !== "string" && typeof id !== "number") return true;
      if (seen.has(String(id))) return false;
      seen.add(String(id));
      return true;
    });
    repeated = page.documents.length > 0 && fresh.length === 0;
    documents.push(...fresh);
    const done = repeated || page.documents.length === 0 || documents.length >= total || documents.length >= want || page.cursor === undefined || page.cursor === cursor;
    cursor = page.cursor;
    if (done) break;
  }
  return { total, documents, complete: !repeated && documents.length >= total, pages, repeated };
}

/** `value[key]` as a string, if it is one and not blank. */
function text(value: JsonObject | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && !isBlank(field) ? field : undefined;
}

/** `value[key]` as a number (or a string of digits), if it is one. */
function number(value: JsonObject | undefined, key: string): number | undefined {
  const field = value?.[key];
  if (typeof field === "number") return field;
  return typeof field === "string" && /^\d+$/.test(field) ? Number(field) : undefined;
}

/** `value[key]` as a list of objects (anything else left out). */
function objects(value: JsonObject | undefined, key: string): JsonObject[] {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

/** `value[key]` as a list of strings (or numbers as strings). */
function strings(value: JsonObject | undefined, key: string): string[] {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(String) : [];
}

/** `fields` without the undefined values and the empty lists, so a result holds only what DIP gave. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0))) as Partial<T>;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", sect: "§", euro: "€", shy: "",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à",
  bdquo: "„", ldquo: "“", rdquo: "”", sbquo: "‚", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", middot: "·", deg: "°",
};

/**
 * DIP's `abstract` as plain text: it holds HTML (`<br />`, `<strong>`, `&quot;`, `&ndash;`). Line
 * breaks become line breaks, every other tag goes, the entities are decoded (an unknown one is
 * kept as written).
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name] ?? whole;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Why `value` is not a whole number from 1 to `max`, or undefined. */
const wholeUpTo = (max: number) => (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max ? undefined : `Expected a whole number from 1 to ${max}.`;

/** Why `value` is not an offset (a whole number from 0), or undefined. */
const offsetProblem = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? undefined : "Expected a whole number from 0.";

/** An id as DIP sends it: digits, without leading zeros. */
function idOf(name: string, value: string | number): string {
  const raw = typeof value === "number" ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : "") : value.trim();
  if (!/^\d{1,15}$/.test(raw)) throw new DipValidationError(`Invalid ${name}: Expected a numeric DIP id, e.g. 298723.`);
  return raw.replace(/^0+(?=\d)/, "");
}

/** The electoral term (Wahlperiode), if given: 1 to 99. */
function termOf(value: number | undefined): number | undefined {
  return value === undefined ? undefined : assertValid("electoralTerm", value, wholeUpTo(99));
}

/** Exactly one of the ways to name a thing, else a usage error naming them. */
function oneOf(what: string, given: Record<string, unknown>): void {
  const named = Object.entries(given).filter(([, value]) => value !== undefined);
  if (named.length !== 1) {
    throw new DipValidationError(`Give the ${what}'s ${Object.keys(given).join(" or ")} (exactly one of them).`);
  }
}

/** Run `get`, with a 404 as undefined: an id DIP doesn't know is an empty answer, not an error. */
async function orNotFound<T>(get: () => Promise<T>): Promise<T | undefined> {
  try {
    return await get();
  } catch (err) {
    if (err instanceof DipApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** Newest first by `datum` (ISO dates compare as text), DIP's order among equals. */
function newestFirst(a: JsonObject, b: JsonObject): number {
  return (text(b, "datum") ?? "").localeCompare(text(a, "datum") ?? "");
}

const WHOLE_WORDS =
  "DIP's title filter (f.titel) matches whole words of the title only: not the abstract, not word parts (\"Gebäudeenergie\" misses \"Gebäudeenergiegesetzes\"); several words are searched as a phrase.";

// ---- trackProcedure ------------------------------------------------------------------------

/** The input of {@link trackProcedure}: the procedure's id, or words of its title. */
export interface TrackProcedureInput {
  /** The Vorgang id (from DIP, e.g. 298723). */
  id?: string | number | undefined;
  /** Whole words of the procedure's title (f.titel), e.g. "Heizungsgesetz". */
  title?: string | undefined;
  /** The electoral term (Wahlperiode) a title search is limited to: 21 is the current one. */
  electoralTerm?: number | undefined;
  /** The procedure type a title search is limited to (f.vorgangstyp), e.g. "Gesetzgebung". */
  type?: string | undefined;
  /** At most this many candidates when several match (1-25, default 10). */
  limit?: number | undefined;
}

/** What a decision at a step is. Only `vote` is a vote on the bill itself. */
export type DecisionKind = "vote" | "referral" | "procedural" | "opinion" | "resolution" | "bundesrat" | "other";

/** A decision taken at a step (`beschlussfassung`). */
export interface Decision {
  kind: DecisionKind;
  /** `beschlusstenor`, e.g. "Annahme in Ausschussfassung". */
  text: string;
  /** `abstimmungsart`, e.g. "Namentliche Abstimmung" (only when given). */
  method?: string;
  /** `mehrheit` (only when given). */
  majority?: string;
  /** `abstimm_ergebnis_bemerkung`, e.g. "397:275:5" (yes:no:abstentions, only when given). */
  result?: string;
  /** The documents decided on (`dokumentnummer`). */
  documents?: string;
  /** The page of the protocol (`seite`). */
  page?: string;
  /** The legal basis (`grundlage`), e.g. "Art. 77 Abs. 2 GG". */
  basis?: string;
}

/** A committee a step referred the bill to (`ueberweisung`). */
export interface Referral {
  committee: string;
  abbreviation?: string;
  /** True for the lead committee (federführend). */
  lead: boolean;
  kind?: string;
}

/** One step of a procedure (a Vorgangsposition). */
export interface ProcedureStep {
  id?: string;
  date?: string;
  /** BT (Bundestag) or BR (Bundesrat), from `zuordnung`. */
  chamber?: string;
  /** The step, e.g. "1. Beratung", "Beschlussempfehlung und Bericht". */
  step?: string;
  /** The document of the step: "Drucksache 20/6875", "Plenarprotokoll 20/120". */
  document?: string;
  pdfUrl?: string;
  decisions?: Decision[];
  referrals?: Referral[];
  /** How many activities (speeches, questions) belong to the step. */
  activities?: number;
}

/** A procedure (Vorgang) as the tracker reports it. */
export interface ProcedureSummary {
  id: string;
  title?: string;
  type?: string;
  /** `beratungsstand`: where it stands, in DIP's words. The headline. */
  status?: string;
  electoralTerm?: number;
  /** Date of the latest step. */
  date?: string;
  initiative?: string[];
  /** The abstract, HTML removed. */
  abstract?: string;
  /** Whether the Bundesrat's consent is needed (`zustimmungsbeduerftigkeit`). */
  consent?: string[];
  gesta?: string;
}

/** A candidate procedure of an ambiguous title search. */
export interface ProcedureCandidate {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  electoralTerm?: number;
  date?: string;
}

/** The answer of {@link trackProcedure}. */
export type ProcedureTrack =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      procedure: ProcedureSummary;
      /** True when the law is promulgated or in force (`verkuendung` / `inkrafttreten` given). */
      enacted: boolean;
      promulgation?: { reference?: string; date?: string; pdfUrl?: string }[];
      inForce?: { date?: string; note?: string }[];
      /** Every step, oldest first. */
      timeline: ProcedureStep[];
      /** The decisions that are votes on the bill (2./3. Beratung, or on the mediation committee's proposal), with their step. */
      votes: (Decision & { date?: string; chamber?: string; step?: string })[];
      /** The lead committees (federführend), per chamber (the Bundesrat refers to its own). */
      leadCommittees: { chamber?: string; committee: string }[];
      /** How many steps DIP holds; more than the timeline's length when the reading stopped early (`complete` false, `note` says why). */
      stepsTotal: number;
      complete: boolean;
      note?: string;
    }
  | { status: "ambiguous"; searched: Record<string, unknown>; total: number; candidates: ProcedureCandidate[]; complete: boolean; note?: string }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

/**
 * What a decision is: a procedural motion, a referral, a Bundesrat opinion, a resolution, the
 * Bundesrat's decision (in its 2. Durchgang, or in a later sitting: the consent or objection after
 * the mediation committee), or a vote on the bill (an adoption or rejection in the 2./3. Beratung,
 * or of the mediation committee's proposal, "Abstimmung über Vermittlungsvorschlag": the version
 * that becomes law). Not every `beschlussfassung` is a vote: "Überweisung" at a 1. Beratung is the
 * referral, "Annahme Geschäftsordnungsantrag" a procedural motion, "Annahme einer Entschließung"
 * a resolution.
 */
export function decisionKind(step: string, tenor: string, chamber: string | undefined): DecisionKind {
  if (/geschäftsordnung/i.test(tenor) || /geschäftsordnung/i.test(step)) return "procedural";
  if (/überweisung/i.test(tenor)) return "referral";
  if (/^\s*stellungnahme/i.test(tenor)) return "opinion";
  if (chamber === "BR" && /durchgang/i.test(step)) return "bundesrat";
  if (/entschließung/i.test(tenor)) return "resolution";
  if (chamber === "BR") return "bundesrat";
  if (/^\s*(annahme|ablehnung)/i.test(tenor) && (/(^|\D)[23]\.\s*beratung/i.test(step) || /vermittlungsvorschlag/i.test(step))) return "vote";
  return "other";
}

function decisionOf(raw: JsonObject, step: string, chamber: string | undefined): Decision | undefined {
  const tenor = text(raw, "beschlusstenor");
  if (tenor === undefined) return undefined;
  return {
    kind: decisionKind(step, tenor, chamber),
    text: tenor,
    ...defined({
      method: text(raw, "abstimmungsart"),
      majority: text(raw, "mehrheit"),
      result: text(raw, "abstimm_ergebnis_bemerkung"),
      documents: text(raw, "dokumentnummer"),
      page: text(raw, "seite"),
      basis: text(raw, "grundlage"),
    }),
  };
}

function stepOf(raw: JsonObject): ProcedureStep {
  const step = text(raw, "vorgangsposition") ?? "";
  const chamber = text(raw, "zuordnung");
  const fundstelle = raw["fundstelle"] as JsonObject | undefined;
  const kind = text(fundstelle, "dokumentart");
  const nr = text(fundstelle, "dokumentnummer");
  const decisions = objects(raw, "beschlussfassung").flatMap((d) => decisionOf(d, step, chamber) ?? []);
  const referrals = objects(raw, "ueberweisung").map(
    (u): Referral => ({ committee: text(u, "ausschuss") ?? "", lead: u["federfuehrung"] === true, ...defined({ abbreviation: text(u, "ausschuss_kuerzel"), kind: text(u, "ueberweisungsart") }) }),
  );
  const activities = number(raw, "aktivitaet_anzahl");
  return defined({
    id: text(raw, "id"),
    date: text(raw, "datum"),
    chamber,
    step: step || undefined,
    document: kind !== undefined && nr !== undefined ? `${kind} ${nr}` : (nr ?? kind),
    pdfUrl: text(fundstelle, "pdf_url"),
    decisions,
    referrals,
    activities: activities === 0 ? undefined : activities,
  }) as ProcedureStep;
}

function procedureOf(raw: JsonObject): ProcedureSummary {
  const abstract = text(raw, "abstract");
  return {
    id: text(raw, "id") ?? String(raw["id"] ?? ""),
    ...defined({
      title: text(raw, "titel"),
      type: text(raw, "vorgangstyp"),
      status: text(raw, "beratungsstand"),
      electoralTerm: number(raw, "wahlperiode"),
      date: text(raw, "datum"),
      initiative: strings(raw, "initiative"),
      abstract: abstract === undefined ? undefined : plainText(abstract),
      consent: strings(raw, "zustimmungsbeduerftigkeit"),
      gesta: text(raw, "gesta"),
    }),
  };
}

function procedureCandidate(raw: JsonObject): ProcedureCandidate {
  const { id, title, type, status, electoralTerm, date } = procedureOf(raw);
  return defined({ id, title, type, status, electoralTerm, date }) as ProcedureCandidate;
}

/**
 * A legislative procedure (Vorgang) end to end: by id, or by whole words of its title (one
 * match is the answer; several are `ambiguous`, laws first, then newest; the caller asks which
 * one). Its steps are read with `f.vorgang` on the positions (the vorgang endpoint has no such
 * filter), every page with the same filter, and sorted oldest first (DIP's order is not
 * chronological). Each decision is named for what it is (see {@link decisionKind}); `enacted`
 * only from promulgation or entry into force, never from an "Annahme".
 */
export async function trackProcedure(client: DipClient, input: TrackProcedureInput, options: OperationOptions = {}): Promise<ProcedureTrack> {
  oneOf("procedure", { id: input.id, title: input.title });
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const limit = assertValid("limit", input.limit ?? 10, wholeUpTo(25));
  let id: string;
  let searched: Record<string, unknown>;
  if (input.id !== undefined) {
    id = idOf("id", input.id);
    searched = { id };
  } else {
    const title = normalizeText(assertValid("title", input.title as string, textProblem));
    const term = termOf(input.electoralTerm);
    const type = input.type === undefined ? undefined : normalizeText(assertValid("type", input.type, textProblem));
    searched = defined({ title, electoralTerm: term, type });
    const page = await client.vorgaenge.list({ "f.titel": title, "f.wahlperiode": term, "f.vorgangstyp": type });
    if (page.documents.length === 0) {
      return {
        status: "empty",
        searched,
        reason: `No procedure's title holds "${title}"${term === undefined ? "" : ` in electoral term ${term}`}${type === undefined ? "" : ` of type ${type}`}. ${WHOLE_WORDS} A law's popular name is often only in its abstract: try a word of the official title${type === undefined ? "" : ", or no type"}${term === undefined ? "" : ", or another term"}.`,
      };
    }
    if (page.documents.length > 1) {
      const laws = (doc: JsonObject) => (text(doc, "vorgangstyp") === "Gesetzgebung" ? 0 : 1);
      const ranked = [...page.documents].sort((a, b) => laws(a) - laws(b) || newestFirst(a, b));
      const noLaw = type === undefined && ranked.every((doc) => laws(doc) === 1);
      return {
        status: "ambiguous",
        searched,
        total: page.numFound,
        candidates: ranked.slice(0, limit).map(procedureCandidate),
        complete: page.numFound <= limit,
        ...(noLaw
          ? { note: "None of these is a law (Gesetzgebung): a law's popular name is often not in its title. Retry with a word of the official title and type Gesetzgebung." }
          : {}),
      };
    }
    id = text(page.documents[0], "id") ?? String(page.documents[0]?.["id"]);
  }
  const raw = await orNotFound(() => client.vorgaenge.get(id));
  if (raw === undefined) return { status: "empty", searched, reason: `DIP has no procedure (Vorgang) with id ${id}. Ids come from DIP's answers; search by title words instead.` };
  const positions = await collect(client, "vorgangsposition", { "f.vorgang": id }, maxPages);
  const timeline = positions.documents.map(stepOf).map((step, index) => ({ step, index }));
  // Oldest first; DIP's order among steps of the same day.
  timeline.sort((a, b) => (a.step.date ?? "").localeCompare(b.step.date ?? "") || a.index - b.index);
  const steps = timeline.map(({ step }) => step);
  const votes = steps.flatMap((s) => (s.decisions ?? []).filter((d) => d.kind === "vote").map((d) => ({ ...d, ...defined({ date: s.date, chamber: s.chamber, step: s.step }) })));
  // Each chamber refers a bill to its own committees: the lead ones per chamber, each once.
  const leadCommittees: { chamber?: string; committee: string }[] = [];
  for (const s of steps) {
    for (const r of s.referrals ?? []) {
      if (!r.lead || r.committee === "" || leadCommittees.some((l) => l.committee === r.committee && l.chamber === s.chamber)) continue;
      leadCommittees.push({ ...defined({ chamber: s.chamber }), committee: r.committee });
    }
  }
  const promulgation = objects(raw, "verkuendung").map((v) => defined({ reference: text(v, "fundstelle"), date: text(v, "verkuendungsdatum"), pdfUrl: text(v, "pdf_url") }));
  const inForce = objects(raw, "inkrafttreten").map((v) => defined({ date: text(v, "datum"), note: text(v, "erlaeuterung") }));
  const notes: string[] = [];
  if (steps.length === 0) notes.push("DIP lists no steps for this procedure yet.");
  if (steps.length === 1) notes.push("One step only: normal for a question that is not answered yet, or a fresh procedure.");
  if (!positions.complete) notes.push(`Only ${steps.length} of ${positions.total} steps were read (${partly(positions)}); the timeline is incomplete.`);
  return {
    status: "ok",
    searched,
    procedure: procedureOf(raw),
    enacted: promulgation.length > 0 || inForce.length > 0,
    ...(promulgation.length > 0 ? { promulgation } : {}),
    ...(inForce.length > 0 ? { inForce } : {}),
    timeline: steps,
    votes,
    leadCommittees,
    stepsTotal: positions.total,
    complete: positions.complete,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

// ---- profileMember -------------------------------------------------------------------------

/** The input of {@link profileMember}: the person's id, or a name. */
export interface ProfileMemberInput {
  /** The DIP person id (e.g. 1502). */
  id?: string | number | undefined;
  /** A complete last name ("Baerbock"), or first and last name ("Dagmar Schmidt", "Schmidt, Dagmar"). */
  name?: string | undefined;
  /** The electoral term the name search is limited to; with it, a name `f.person` misses is looked for in the term's whole list. */
  electoralTerm?: number | undefined;
  /** Also list the person's activities (speeches, questions, signed papers) of a term. */
  activities?: boolean | undefined;
  /** At most this many activities (1-100, default 20). */
  activityLimit?: number | undefined;
  /** At most this many candidates when several match (1-25, default 10). */
  limit?: number | undefined;
}

/** A person as DIP holds them now (the top-level fields). */
export interface MemberProfile {
  id: string;
  name: string;
  /** DIP's display name with function and Fraktion, e.g. "Annalena Baerbock, MdB, BÜNDNIS 90/DIE GRÜNEN". */
  title?: string;
  /** Current functions, abbreviated: MdB, Bundesmin., Parl. Staatssekr., MdBR, … */
  functions?: string[];
  /** Current Fraktion (only when the function is MdB). */
  parliamentaryGroups?: string[];
  /** Ministry of a government function. */
  ministries?: string[];
  /** Land of a Bundesrat member. */
  states?: string[];
  /** Office of a Bundesrat member. */
  offices?: string[];
  /** The place added to tell namesakes apart ("Wetzlar"); not a full Wahlkreis. */
  nameSuffix?: string;
  electoralTerms?: number[];
  /** Latest and first date in the record. */
  latestDate?: string;
  firstDate?: string;
}

/** An earlier or other role (`person_roles`): no role title, a ministry only as its name. */
export interface MemberRole {
  terms?: number[];
  parliamentaryGroup?: string;
  /** `ressort_titel`: the ministry; the role's title is not in the record. */
  ministry?: string;
  office?: string;
  state?: string;
  /** The name held then, when it differs from today's. */
  name?: string;
  nameSuffix?: string;
  /** Said when the record names nothing the role was. */
  note?: string;
}

/** One activity of a person (`aktivitaet`). */
export interface MemberActivity {
  id?: string;
  date?: string;
  /** `aktivitaetsart`: Rede, Kleine Anfrage, Antrag, … */
  kind?: string;
  /** "Plenarprotokoll 21/15", "Drucksache 21/1234". */
  document?: string;
  page?: string;
  pdfUrl?: string;
  procedure?: { id?: string; title?: string; step?: string };
}

/** A candidate of an ambiguous name. */
export interface MemberCandidate {
  id: string;
  title?: string;
  functions?: string[];
  parliamentaryGroups?: string[];
  electoralTerms?: number[];
}

/** The answer of {@link profileMember}. */
export type MemberDossier =
  | {
      status: "ok";
      searched: Record<string, unknown>;
      person: MemberProfile;
      earlierRoles: MemberRole[];
      activities?: { electoralTerm?: number; total: number; byKind: Record<string, number>; counted: number; items: MemberActivity[] };
      resolvedBy?: string;
      note: string;
    }
  | { status: "ambiguous"; searched: Record<string, unknown>; total: number; candidates: MemberCandidate[]; complete: boolean; resolvedBy: string }
  | { status: "empty"; searched: Record<string, unknown>; reason: string; candidates?: MemberCandidate[] };

/** Lower case, composed, without accents (umlauts as their base letter), for comparing names. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("de").replace(/ß/g, "ss").normalize("NFC");
}

const ACADEMIC = /^(dr|prof|med|phil|rer|nat|h\.c|jur|ing|dipl)\.?$/i;

/** The words of a name: "Schmidt, Dagmar" as "Dagmar Schmidt", titles (Dr., Prof.) left out. */
function nameWords(name: string): string[] {
  const comma = name.split(",");
  const ordered = comma.length === 2 ? `${comma[1]} ${comma[0]}` : name;
  return ordered.split(/\s+/).filter((word) => word !== "" && !ACADEMIC.test(word));
}

/** True when every word of `words` is a whole word of the person's name. */
function nameMatches(person: JsonObject, words: string[]): boolean {
  const full = ` ${fold([text(person, "vorname"), text(person, "namenszusatz"), text(person, "nachname")].filter(Boolean).join(" ")).replace(/[-‐]/g, " ")} `;
  return words.every((word) => full.includes(` ${fold(word).replace(/[-‐]/g, " ")} `));
}

function memberCandidate(raw: JsonObject): MemberCandidate {
  return {
    id: text(raw, "id") ?? String(raw["id"] ?? ""),
    ...defined({ title: text(raw, "titel"), functions: strings(raw, "funktion"), parliamentaryGroups: strings(raw, "fraktion"), electoralTerms: strings(raw, "wahlperiode").map(Number) }),
  };
}

function profileOf(raw: JsonObject): MemberProfile {
  const name = [text(raw, "vorname"), text(raw, "namenszusatz"), text(raw, "nachname")].filter(Boolean).join(" ");
  return {
    id: text(raw, "id") ?? String(raw["id"] ?? ""),
    name,
    ...defined({
      title: text(raw, "titel"),
      functions: strings(raw, "funktion"),
      parliamentaryGroups: strings(raw, "fraktion"),
      ministries: strings(raw, "ressort"),
      states: strings(raw, "bundesland"),
      offices: strings(raw, "funktionszusatz"),
      nameSuffix: text(raw, "wahlkreiszusatz"),
      electoralTerms: strings(raw, "wahlperiode").map(Number),
      latestDate: text(raw, "datum"),
      firstDate: text(raw, "basisdatum"),
    }),
  };
}

function roleOf(raw: JsonObject, current: string): MemberRole {
  const name = [text(raw, "vorname"), text(raw, "namenszusatz"), text(raw, "nachname")].filter(Boolean).join(" ");
  const role = defined({
    terms: strings(raw, "wahlperiode_nummer").map(Number),
    parliamentaryGroup: text(raw, "fraktion"),
    ministry: text(raw, "ressort_titel"),
    office: text(raw, "funktionszusatz"),
    state: text(raw, "bundesland"),
    name: name !== "" && name !== current ? name : undefined,
    nameSuffix: text(raw, "wahlkreiszusatz"),
  }) as MemberRole;
  // DIP has roles with a name and terms only (Julia Klöckner's in WP 21): the record doesn't say
  // what the role was, and the answer says so rather than giving an empty entry.
  if (role.parliamentaryGroup === undefined && role.ministry === undefined && role.office === undefined && role.state === undefined) {
    role.note = "The record names no ministry, Fraktion or office for this role: what it was is not in DIP's data.";
  }
  return role;
}

function activityOf(raw: JsonObject): MemberActivity {
  const fundstelle = raw["fundstelle"] as JsonObject | undefined;
  const kind = text(fundstelle, "dokumentart") ?? text(raw, "dokumentart");
  const nr = text(fundstelle, "dokumentnummer");
  const procedure = objects(raw, "vorgangsbezug")[0];
  return defined({
    id: text(raw, "id"),
    date: text(raw, "datum"),
    kind: text(raw, "aktivitaetsart"),
    document: kind !== undefined && nr !== undefined ? `${kind} ${nr}` : (nr ?? kind),
    page: text(fundstelle, "seite"),
    pdfUrl: text(fundstelle, "pdf_url"),
    procedure: procedure === undefined ? undefined : (defined({ id: text(procedure, "id"), title: text(procedure, "titel"), step: text(procedure, "vorgangsposition") }) as MemberActivity["procedure"]),
  }) as MemberActivity;
}

const DOSSIER_NOTE =
  "Current function and Fraktion are the top-level fields; earlierRoles hold other or earlier roles, a government role only as its ministry (the role title is not in the record). DIP carries roles, not biographies, committee memberships or votes: say what is absent.";

/**
 * A member of the Bundestag (or another DIP person) as a dossier: by id, or by name. `f.person`
 * matches a complete first or last name ("Klöck" finds nothing), so the search sends the last
 * word and keeps the people whose name holds every word given; one is the answer, several are
 * `ambiguous` (common surnames: ask which). When `f.person` finds nobody and an electoral term
 * is given, the term's whole list is read (DIP orders it by date, not name, so every page) and
 * matched by name. The activities, if asked for, are those of the given term, else the latest
 * term the person appears in, with both filters sent with every page.
 */
export async function profileMember(client: DipClient, input: ProfileMemberInput, options: OperationOptions = {}): Promise<MemberDossier> {
  oneOf("person", { id: input.id, name: input.name });
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const term = termOf(input.electoralTerm);
  const limit = assertValid("limit", input.limit ?? 10, wholeUpTo(25));
  const activityLimit = assertValid("activityLimit", input.activityLimit ?? 20, wholeUpTo(DIP_PAGE_SIZE));
  let raw: JsonObject | undefined;
  let searched: Record<string, unknown>;
  let resolvedBy: string | undefined;
  if (input.id !== undefined) {
    const id = idOf("id", input.id);
    searched = { id };
    raw = await orNotFound(() => client.personen.get(id));
    if (raw === undefined) return { status: "empty", searched, reason: `DIP has no person with id ${id}. Ids come from DIP's answers; search by name instead.` };
  } else {
    const name = normalizeText(assertValid("name", input.name as string, textProblem));
    const words = nameWords(name);
    if (words.length === 0) throw new DipValidationError("Invalid name: Expected a first or last name, e.g. Baerbock.");
    searched = defined({ name, electoralTerm: term });
    const surname = words[words.length - 1] as string;
    const found = await client.personen.list({ "f.person": surname, "f.wahlperiode": term });
    let matches = found.documents.filter((person) => nameMatches(person, words));
    resolvedBy = `f.person=${surname}${term === undefined ? "" : ` within electoral term ${term}`}`;
    if (found.documents.length === 0 && term !== undefined) {
      // f.person misses a name spelled differently in DIP: the term's whole list, matched by name.
      const all = await collect(client, "person", { "f.wahlperiode": term }, maxPages);
      matches = all.documents.filter((person) => nameMatches(person, words));
      resolvedBy = `matched by name across ${all.pages} page(s) of electoral term ${term}${all.complete ? "" : ` (only ${all.documents.length} of ${all.total} people read: ${partly(all)})`}`;
    }
    if (matches.length === 0) {
      const others = found.documents.map(memberCandidate).slice(0, limit);
      return {
        status: "empty",
        searched,
        reason:
          found.documents.length > 0
            ? `${found.numFound} people are named ${surname}${term === undefined ? "" : ` in term ${term}`}, none with every word of "${name}" (candidates). Check the first name, or ask with the id.`
            : `Nobody named "${name}"${term === undefined ? "" : ` in electoral term ${term}`}. f.person matches a complete first or last name ("Klöck" finds nothing)${term === undefined ? "; give electoralTerm (21 is the current one) to look through that term's whole list" : ""}. Check the spelling, another term, or ask for the id.`,
        ...(others.length > 0 ? { candidates: others } : {}),
      };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", searched, total: matches.length, candidates: matches.slice(0, limit).map(memberCandidate), complete: matches.length <= limit, resolvedBy };
    }
    raw = matches[0] as JsonObject;
  }
  const person = profileOf(raw);
  const earlierRoles = objects(raw, "person_roles").map((role) => roleOf(role, person.name));
  const notes = [DOSSIER_NOTE];
  const functions = person.functions ?? [];
  if ((person.parliamentaryGroups ?? []).length === 0 && functions.length > 0 && !functions.includes("MdB")) {
    notes.push(`No Fraktion: DIP gives one only for the function MdB, and the current function is ${functions.join(", ")}.`);
  }
  let activities: Extract<MemberDossier, { status: "ok" }>["activities"];
  if (input.activities === true) {
    const activityTerm = term ?? Math.max(0, ...(person.electoralTerms ?? []));
    const filters = { "f.person_id": person.id, ...(activityTerm > 0 ? { "f.wahlperiode": activityTerm } : {}) };
    const read = await collect(client, "aktivitaet", filters, maxPages, activityLimit);
    const items = read.documents.map(activityOf).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    const byKind: Record<string, number> = {};
    for (const item of items) byKind[item.kind ?? "?"] = (byKind[item.kind ?? "?"] ?? 0) + 1;
    activities = { ...(activityTerm > 0 ? { electoralTerm: activityTerm } : {}), total: read.total, byKind, counted: read.documents.length, items: items.slice(0, activityLimit) };
    if (read.total > read.documents.length) notes.push(`activities: byKind counts the ${read.documents.length} read of ${read.total}; raise activityLimit or page with searchRecords (aktivitaet, f.person_id and f.wahlperiode) for more.`);
  }
  return {
    status: "ok",
    searched,
    person,
    earlierRoles,
    ...(activities === undefined ? {} : { activities }),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    note: notes.join(" "),
  };
}

// ---- readDocument --------------------------------------------------------------------------

/** The documents with a full text: printed papers and plenary minutes. */
export const DOCUMENT_KINDS = ["drucksache", "plenarprotokoll"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The longest passage of a document's text (characters): lines are kept whole where they fit. */
export const PASSAGE_CHARS = 1500;

/** The input of {@link readDocument}: the document's id, its number, or words of its title. */
export interface ReadDocumentInput {
  /** drucksache (default) or plenarprotokoll. */
  kind?: DocumentKind | undefined;
  /** The DIP id of the document (e.g. 267686). */
  id?: string | number | undefined;
  /** The document number: "20/6875" (BT-Drucksache), "170/23" (BR-Drucksache), "20/120" (a Bundestag sitting), "1033" (a Bundesrat sitting). */
  number?: string | undefined;
  /** Whole words of the title (f.titel). */
  title?: string | undefined;
  /** The electoral term a number or title search is limited to. */
  electoralTerm?: number | undefined;
  /** Only the passages that hold this text (case, line breaks and hyphenation at a line end aside). */
  find?: string | undefined;
  /** The first passage to give (of all, or of those `find` selects; default 0). */
  offset?: number | undefined;
  /** At most this many passages (1-40, default 8). */
  limit?: number | undefined;
  /** At most this many candidates when several match (1-25, default 10). */
  candidateLimit?: number | undefined;
}

/** A document's metadata, as the digest cites it. */
export interface DocumentInfo {
  id: string;
  kind: DocumentKind;
  /** "Drucksache 20/6875" style number. */
  number?: string;
  /** The citation DIP's terms ask for: "BT-Drs. 20/6875", "BT-PlPr. 20/120". */
  cite?: string;
  /** Drucksachetyp: Gesetzentwurf, Antrag, Kleine Anfrage, … */
  type?: string;
  title?: string;
  date?: string;
  electoralTerm?: number;
  /** BT or BR. */
  publisher?: string;
  authors?: string[];
  originators?: string[];
  ministries?: string[];
  abstract?: string;
  /** The procedures the document belongs to (dip-procedure-tracker takes the id). */
  procedures?: { id?: string; title?: string; type?: string }[];
  /** The authoritative PDF. */
  pdfUrl?: string;
}

/** A passage of a document's text: `index` counts the passages of the whole text. */
export interface Passage {
  index: number;
  text: string;
}

/** A candidate document of an ambiguous number or title. */
export interface DocumentCandidate {
  id: string;
  number?: string;
  type?: string;
  title?: string;
  date?: string;
  electoralTerm?: number;
  publisher?: string;
}

/** The answer of {@link readDocument}. */
export type DocumentReading =
  | {
      status: "ok" | "empty";
      searched: Record<string, unknown>;
      document: DocumentInfo;
      /** The characters of the extracted text (0: none extracted yet). */
      textLength: number;
      /** How many passages the whole text has. */
      totalPassages: number;
      /** With `find`: how many passages hold it. */
      matches?: number;
      passages: Passage[];
      nextOffset?: number;
      reason?: string;
      note?: string;
    }
  | { status: "ambiguous"; searched: Record<string, unknown>; total: number; candidates: DocumentCandidate[]; complete: boolean }
  | { status: "empty"; searched: Record<string, unknown>; reason: string };

/**
 * `text` in passages of at most `max` characters, cut at line ends (a longer line at a space,
 * else hard): every character kept, in order, so the passages joined give the text back.
 */
export function splitPassages(text: string, max = PASSAGE_CHARS): string[] {
  const passages: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current !== "") passages.push(current);
    current = "";
  };
  for (const line of text.split(/(?<=\n)/)) {
    if (current.length + line.length <= max) {
      current += line;
      continue;
    }
    flush();
    let rest = line;
    while (rest.length > max) {
      const space = rest.lastIndexOf(" ", max);
      const cut = space > max / 2 ? space + 1 : max;
      passages.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  flush();
  return passages;
}

/**
 * A text as `find` compares it, in two forms: folded with whitespace as one space, and the same
 * with a word hyphenated at a line end joined ("Gebäude-\nenergie" as "gebäudeenergie"; the
 * first form keeps "Kehr- und").
 */
function searchable(value: string): string[] {
  const plain = fold(value).replace(/\s+/g, " ");
  return [plain, fold(value.replace(/(\p{L})-[ \t]*\n[ \t]*(\p{Ll})/gu, "$1$2")).replace(/\s+/g, " ")];
}

const CITE: Record<string, string> = { "drucksache:BT": "BT-Drs.", "drucksache:BR": "BR-Drs.", "plenarprotokoll:BT": "BT-PlPr.", "plenarprotokoll:BR": "BR-PlPr." };

function documentOf(raw: JsonObject, kind: DocumentKind): DocumentInfo {
  const fundstelle = raw["fundstelle"] as JsonObject | undefined;
  const publisher = text(raw, "herausgeber") ?? text(fundstelle, "herausgeber");
  const nr = text(raw, "dokumentnummer");
  const prefix = publisher === undefined ? undefined : CITE[`${kind}:${publisher}`];
  const abstract = text(raw, "abstract");
  return {
    id: text(raw, "id") ?? String(raw["id"] ?? ""),
    kind,
    ...defined({
      number: nr,
      cite: nr !== undefined && prefix !== undefined ? `${prefix} ${nr}` : undefined,
      type: text(raw, "drucksachetyp"),
      title: text(raw, "titel"),
      date: text(raw, "datum"),
      electoralTerm: number(raw, "wahlperiode"),
      publisher,
      authors: objects(raw, "autoren_anzeige").flatMap((a) => text(a, "titel") ?? []),
      originators: objects(raw, "urheber").flatMap((u) => text(u, "titel") ?? []),
      ministries: objects(raw, "ressort").flatMap((r) => text(r, "titel") ?? []),
      abstract: abstract === undefined ? undefined : plainText(abstract),
      procedures: objects(raw, "vorgangsbezug").map((v) => defined({ id: text(v, "id"), title: text(v, "titel"), type: text(v, "vorgangstyp") })),
      pdfUrl: text(fundstelle, "pdf_url") ?? text(raw, "pdf_url"),
    }),
  };
}

function documentCandidate(raw: JsonObject): DocumentCandidate {
  return {
    id: text(raw, "id") ?? String(raw["id"] ?? ""),
    ...defined({
      number: text(raw, "dokumentnummer"),
      type: text(raw, "drucksachetyp") ?? text(raw, "dokumentart"),
      title: text(raw, "titel"),
      date: text(raw, "datum"),
      electoralTerm: number(raw, "wahlperiode"),
      publisher: text(raw, "herausgeber"),
    }),
  };
}

/**
 * A Drucksache or Plenarprotokoll with its full text, for a digest. By id the text endpoint is
 * read at once; a number or title words are resolved on the light metadata endpoint first (never
 * by listing the heavy `-text` endpoint): one match is read, several are `ambiguous` (newest
 * first; a number can name a Bundestag and a Bundesrat paper), none is `empty` saying why. The
 * text comes in passages (at most {@link PASSAGE_CHARS} characters, cut at line ends, verbatim:
 * it is the extraction of the PDF, with its hyphenation and page furniture), `limit` at a time
 * from `offset`; with `find`, only the passages that hold the words. A document without extracted
 * text says so and points to the PDF.
 */
export async function readDocument(client: DipClient, input: ReadDocumentInput): Promise<DocumentReading> {
  oneOf("document", { id: input.id, number: input.number, title: input.title });
  const kind = input.kind ?? "drucksache";
  if (!DOCUMENT_KINDS.includes(kind)) throw new DipValidationError(`Invalid kind: Expected one of ${DOCUMENT_KINDS.join(", ")}.`);
  const term = termOf(input.electoralTerm);
  const offset = assertValid("offset", input.offset ?? 0, offsetProblem);
  const limit = assertValid("limit", input.limit ?? 8, wholeUpTo(40));
  const candidateLimit = assertValid("candidateLimit", input.candidateLimit ?? 10, wholeUpTo(25));
  const find = input.find === undefined ? undefined : normalizeText(assertValid("find", input.find, textProblem));
  const label = kind === "drucksache" ? "Drucksache" : "Plenarprotokoll";
  let id: string;
  let searched: Record<string, unknown>;
  if (input.id !== undefined) {
    id = idOf("id", input.id);
    searched = defined({ kind, id, find });
  } else {
    const byNumber = input.number !== undefined;
    const value = normalizeText(assertValid(byNumber ? "number" : "title", (input.number ?? input.title) as string, textProblem));
    searched = defined({ kind, ...(byNumber ? { number: value } : { title: value }), electoralTerm: term, find });
    const page = await group(client, kind).list({ [byNumber ? "f.dokumentnummer" : "f.titel"]: value, "f.wahlperiode": term });
    if (page.documents.length === 0) {
      return {
        status: "empty",
        searched,
        reason: byNumber
          ? `No ${label} numbered ${value}${term === undefined ? "" : ` in electoral term ${term}`}. A Bundestag Drucksache is term/number ("20/6875"), a Bundesrat one number/year ("170/23"); a Bundestag sitting's protocol is term/sitting ("20/120"), a Bundesrat one the sitting ("1033"). Check the number and the kind.`
          : `No ${label}'s title holds "${value}"${term === undefined ? "" : ` in electoral term ${term}`}. ${WHOLE_WORDS} Try another word of the title${term === undefined ? "" : " or another term"}.`,
      };
    }
    if (page.documents.length > 1) {
      const ranked = [...page.documents].sort(newestFirst);
      return { status: "ambiguous", searched, total: page.numFound, candidates: ranked.slice(0, candidateLimit).map(documentCandidate), complete: page.numFound <= candidateLimit };
    }
    id = text(page.documents[0], "id") ?? String(page.documents[0]?.["id"]);
  }
  const textGroup = kind === "drucksache" ? client.drucksacheText : client.plenarprotokollText;
  const raw = await orNotFound(() => textGroup.get(id));
  if (raw === undefined) return { status: "empty", searched, reason: `DIP has no ${label} with id ${id}. Ids come from DIP's answers; search by number or title words instead, and check the kind.` };
  const document = documentOf(raw, kind);
  const body = typeof raw["text"] === "string" ? raw["text"] : "";
  const all = isBlank(body) ? [] : splitPassages(body);
  const base = { searched, document, textLength: isBlank(body) ? 0 : body.length, totalPassages: all.length };
  if (all.length === 0) {
    return {
      status: "ok",
      ...base,
      passages: [],
      note: `DIP has no extracted text for this ${label} yet: read the PDF${document.pdfUrl === undefined ? "" : ` (${document.pdfUrl})`} and say the body isn't extracted.`,
    };
  }
  let selected = all.map((passage, index): Passage => ({ index, text: passage }));
  if (find !== undefined) {
    const wanted = fold(find).replace(/\s+/g, " ");
    // A phrase can run across the end of a passage: each is compared with the start of the next.
    selected = selected.filter((passage, i) => searchable(passage.text + (all[i + 1] ?? "").slice(0, find.length + 40)).some((form) => form.includes(wanted)));
    if (selected.length === 0) {
      return {
        status: "empty",
        ...base,
        matches: 0,
        passages: [],
        reason: `No passage of ${document.cite ?? label} holds "${find}". Try another word: a topic word of the agenda item, a speaker's surname, or "Tagesordnungspunkt".`,
      };
    }
  }
  const page = selected.slice(offset, offset + limit);
  const next = offset + page.length;
  const notes: string[] = ["The text is the extraction of the PDF: expect words hyphenated at line ends, headers, footers and page numbers; clean lightly before quoting and cite the document (cite, pdfUrl)."];
  if (kind === "plenarprotokoll" && find === undefined) {
    notes.push("A Plenarprotokoll is the whole sitting, many agenda items: use find with the topic or a speaker to locate the item, and never digest the whole day.");
  }
  return {
    status: page.length === 0 ? "empty" : "ok",
    ...base,
    ...(find === undefined ? {} : { matches: selected.length }),
    passages: page,
    ...(next < selected.length ? { nextOffset: next } : {}),
    ...(page.length === 0 ? { reason: `offset ${offset} is past the last passage (${selected.length}).` } : {}),
    note: notes.join(" "),
  };
}

// ---- listRecords, getRecord ----------------------------------------------------------------

/** A filter value: one value, or several (DIP's OR set, e.g. several ids). */
export type FilterValue = string | number | (string | number)[];

/** The input of {@link listRecords}. */
export interface ListRecordsInput {
  resource: RecordResource;
  /** DIP's filters by their names (`f.titel`, `f.wahlperiode`, `f.aktualisiert.start`, …). */
  filters?: Record<string, FilterValue> | undefined;
  /** The first record to give (default 0). */
  offset?: number | undefined;
  /** At most this many records (1-100, default 20). */
  limit?: number | undefined;
}

/** The answer of {@link listRecords}. */
export interface RecordList {
  status: "ok" | "empty";
  searched: { resource: RecordResource; filters: Record<string, FilterValue> };
  total: number;
  records: JsonObject[];
  nextOffset?: number;
  reason?: string;
  note?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The filters in the form DIP accepts: `f.aktualisiert.*` wants a full date and time (a bare date
 * is answered 400), so a date gets the day's start or end; `f.datum.*` wants a calendar date, so
 * a time is cut off. What was changed is said in the notes.
 */
function dipFilters(filters: Record<string, FilterValue>, notes: string[]): QueryParams {
  const out: QueryParams = Object.create(null) as QueryParams;
  for (const [key, value] of Object.entries(filters)) {
    const one = (item: string | number): QueryPrimitive => {
      if (typeof item !== "string") return item;
      const trimmed = item.trim();
      if (key.startsWith("f.aktualisiert.") && DATE_ONLY.test(trimmed)) {
        const time = key.endsWith(".end") ? "T23:59:59" : "T00:00:00";
        notes.push(`${key}: DIP wants a date and time; sent ${trimmed}${time}.`);
        return `${trimmed}${time}`;
      }
      const dated = key.startsWith("f.datum.") ? DATE_TIME.exec(trimmed) : null;
      if (dated !== null) {
        notes.push(`${key}: DIP wants a calendar date; sent ${dated[1]}.`);
        return dated[1] as string;
      }
      return item;
    };
    out[key] = Array.isArray(value) ? value.map(one) : one(value);
  }
  return out;
}

/**
 * One metadata resource's records with DIP's filters (`f.*`, checked against the resource's
 * list: DIP ignores an unknown one and answers everything), `limit` from `offset`, read in DIP's
 * pages of 100 with the filters sent again with every cursor. At most `maxPages` pages are read,
 * so `offset + limit` is at most `maxPages * 100`; narrow the filters (a date range) to reach
 * further. `nextOffset` is offered only where the next call can start: at that limit the answer
 * has none, and its note says to narrow the filters.
 */
export async function listRecords(client: DipClient, input: ListRecordsInput, options: OperationOptions = {}): Promise<RecordList> {
  const resource = input.resource;
  if (!RECORD_RESOURCES.includes(resource)) {
    throw new DipValidationError(`Invalid resource: Expected one of ${RECORD_RESOURCES.join(", ")} (a document's full text comes from readDocument).`);
  }
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const offset = assertValid("offset", input.offset ?? 0, offsetProblem);
  const limit = assertValid("limit", input.limit ?? 20, wholeUpTo(DIP_PAGE_SIZE));
  const filters = input.filters ?? {};
  if ("cursor" in filters) throw new DipValidationError("Invalid filters: page with offset and limit, not a cursor.");
  for (const key of Object.keys(filters)) {
    if (!LIST_FILTERS[resource].includes(key)) {
      throw new DipValidationError(`Invalid filter "${key}" for ${resource}: DIP ignores unknown filters and would answer the whole list. Filters for ${resource}: ${LIST_FILTERS[resource].join(", ")}.`);
    }
  }
  if (offset + limit > maxPages * DIP_PAGE_SIZE) {
    throw new DipValidationError(`Invalid offset: DIP pages with a cursor, ${DIP_PAGE_SIZE} records a page, and this reads at most ${maxPages} pages a call, so offset + limit can be at most ${maxPages * DIP_PAGE_SIZE}. Narrow the filters (f.datum.start/end, f.wahlperiode) instead.`);
  }
  const notes: string[] = [];
  const read = await collect(client, resource, dipFilters(filters, notes), maxPages, offset + limit);
  const records = read.documents.slice(offset, offset + limit);
  const searched = { resource, filters };
  const next = offset + records.length;
  if (read.repeated) notes.push(`${partly(read)}: ${read.documents.length} of ${read.total} records could be read; narrow the filters (f.datum.start/end) to reach the others.`);
  // The next call could start at most here: past it, offset + limit would be refused.
  const reachable = Math.min(read.repeated ? read.documents.length : read.total, maxPages * DIP_PAGE_SIZE);
  if (next >= maxPages * DIP_PAGE_SIZE && next < read.total && !read.repeated) {
    notes.push(`These are the last records this reads: only the first ${maxPages * DIP_PAGE_SIZE} of the ${read.total} records can be reached by offset (at most ${maxPages} pages of ${DIP_PAGE_SIZE} a call); narrow the filters (f.datum.start/end, f.wahlperiode) to reach the others.`);
  }
  if (read.total === 0) {
    return { status: "empty", searched, total: 0, records, reason: "No record matches these filters. Text filters match whole words (f.titel), f.person complete names; drop a filter or widen the dates.", ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
  }
  return {
    status: records.length === 0 ? "empty" : "ok",
    searched,
    total: read.total,
    records,
    ...(next < reachable && records.length > 0 ? { nextOffset: next } : {}),
    ...(records.length === 0 ? { reason: `offset ${offset} is past the last record (${read.total}).` } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/** The answer of {@link getRecord}. */
export type RecordLookup = { status: "ok"; record: JsonObject } | { status: "empty"; searched: { resource: RecordResource; id: string }; reason: string };

/** One metadata record by resource and id, with all its fields; an id DIP doesn't know is `empty`, saying so. */
export async function getRecord(client: DipClient, resource: RecordResource, id: string | number): Promise<RecordLookup> {
  if (!RECORD_RESOURCES.includes(resource)) {
    throw new DipValidationError(`Invalid resource: Expected one of ${RECORD_RESOURCES.join(", ")} (a document's full text comes from readDocument).`);
  }
  const wanted = idOf("id", id);
  const record = await orNotFound(() => group(client, resource).get(wanted));
  if (record === undefined) return { status: "empty", searched: { resource, id: wanted }, reason: `DIP has no ${resource} with id ${wanted}. Ids come from DIP's answers (searchRecords and the other tools).` };
  return { status: "ok", record };
}
