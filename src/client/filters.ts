// The `f.*` filters each DIP list endpoint accepts, from the official OpenAPI
// description (https://search.dip.bundestag.de/api/v1/openapi.yaml, version 1.5,
// read 2026-09-26).
//
// DIP ignores a query parameter it does not know: `vorgang list` with a mistyped
// `f.titl=Klima`, or with `f.person` (which only `person`/`aktivitaet` have),
// answers with the whole unfiltered list and HTTP 200. So the library's
// `list(params)` rejects any other key before the request (`filterKeyProblem`),
// and the CLI's `--filter` uses the same check. A filter DIP adds after this
// table was read can still be sent with `list(params, { allowUnknownFilters: true })`.

/** The list endpoints, by their path segment under `/api/v1`. */
export type ListResource =
  | "vorgang"
  | "vorgangsposition"
  | "drucksache"
  | "drucksache-text"
  | "plenarprotokoll"
  | "plenarprotokoll-text"
  | "aktivitaet"
  | "person";

const DATES = ["f.aktualisiert.start", "f.aktualisiert.end", "f.datum.start", "f.datum.end"];

const DRUCKSACHE = [
  ...DATES,
  "f.dokumentnummer",
  "f.drucksachetyp",
  "f.id",
  "f.ressort_fdf",
  "f.titel",
  "f.urheber",
  "f.vorgangstyp",
  "f.vorgangstyp_notation",
  "f.wahlperiode",
  "f.zuordnung",
];

const PLENARPROTOKOLL = [
  ...DATES,
  "f.dokumentnummer",
  "f.id",
  "f.vorgangstyp",
  "f.vorgangstyp_notation",
  "f.wahlperiode",
  "f.zuordnung",
];

/** The `f.*` filter names each list endpoint accepts. */
export const LIST_FILTERS: Readonly<Record<ListResource, readonly string[]>> = {
  vorgang: [
    ...DATES,
    "f.beratungsstand",
    "f.deskriptor",
    "f.dokumentart",
    "f.dokumentnummer",
    "f.drucksache",
    "f.drucksachetyp",
    "f.frage_nummer",
    "f.gesta",
    "f.id",
    "f.initiative",
    "f.kom",
    "f.plenarprotokoll",
    "f.ratsdok",
    "f.ressort_fdf",
    "f.sachgebiet",
    "f.titel",
    "f.urheber",
    "f.verkuendung_fundstelle",
    "f.vorgangstyp",
    "f.vorgangstyp_notation",
    "f.wahlperiode",
  ],
  vorgangsposition: [
    ...DATES,
    "f.aktivitaet",
    "f.dokumentart",
    "f.dokumentnummer",
    "f.drucksache",
    "f.drucksachetyp",
    "f.frage_nummer",
    "f.id",
    "f.kom",
    "f.plenarprotokoll",
    "f.ratsdok",
    "f.ressort_fdf",
    "f.titel",
    "f.urheber",
    "f.vorgang",
    "f.vorgangstyp",
    "f.vorgangstyp_notation",
    "f.wahlperiode",
    "f.zuordnung",
  ],
  drucksache: DRUCKSACHE,
  "drucksache-text": DRUCKSACHE,
  plenarprotokoll: PLENARPROTOKOLL,
  "plenarprotokoll-text": PLENARPROTOKOLL,
  aktivitaet: [
    ...DATES,
    "f.deskriptor",
    "f.dokumentart",
    "f.dokumentnummer",
    "f.drucksache",
    "f.drucksachetyp",
    "f.frage_nummer",
    "f.id",
    "f.kom",
    "f.person",
    "f.person_id",
    "f.plenarprotokoll",
    "f.ratsdok",
    "f.sachgebiet",
    "f.urheber",
    "f.vorgangsposition_id",
    "f.vorgangstyp",
    "f.vorgangstyp_notation",
    "f.wahlperiode",
    "f.zuordnung",
  ],
  person: [...DATES, "f.id", "f.person", "f.wahlperiode"],
};

/** The paging parameter `list()` takes besides the resource's `f.*` filters. */
export const LIST_PAGING_PARAMS: readonly string[] = ["cursor"];

/**
 * Why `key` cannot be sent to `resource`'s list endpoint, or `undefined` when it is
 * one of the resource's filters (`LIST_FILTERS`) or the `cursor`. DIP ignores an
 * unknown key and answers with the whole unfiltered list, so a typo or another
 * resource's filter must not reach it.
 */
export function filterKeyProblem(resource: ListResource): (key: string) => string | undefined {
  const known = LIST_FILTERS[resource];
  return (key) =>
    known.includes(key) || LIST_PAGING_PARAMS.includes(key)
      ? undefined
      : `Unknown filter "${key}" for ${resource}. DIP ignores unknown filters and would ` +
        `return the whole unfiltered list. Filters for ${resource}: ${known.join(", ")}.`;
}

/**
 * A note for a list request that sends a `cursor` and no filter, or `undefined`. DIP
 * does not bind a cursor to the query it came from: a cursor from a filtered page,
 * sent alone, pages through the whole unfiltered collection (page 2 of
 * `vorgangsposition` for one procedure came back as 100 positions of other procedures
 * from 2007, with HTTP 200). Paging an unfiltered list this way is legitimate, so this
 * is a note for the caller to print, not an error; the CLI prints it on stderr.
 */
export function cursorWithoutFiltersNote(resource: ListResource, params: Record<string, unknown>): string | undefined {
  const present = (key: string): boolean => params[key] !== undefined && params[key] !== null;
  if (!present("cursor")) return undefined;
  if (Object.keys(params).some((key) => key !== "cursor" && present(key))) return undefined;
  return (
    `--cursor without a filter pages through the whole unfiltered ${resource} list: DIP does not ` +
    `keep the filters of the page the cursor came from. If that page was filtered, repeat every ` +
    `--filter and --id of it together with --cursor.`
  );
}
