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

/**
 * The filters whose values are integers in the OpenAPI description (ids, the
 * Wahlperiode, the Vorgangstyp notation). DIP answers a non-integer one with a
 * misleading `400 Invalid cursor` or 0 hits, so `list()` and the CLI's `--filter`/`--id`
 * check the value first (`integerFilterProblem`).
 */
export const INTEGER_FILTERS: readonly string[] = [
  "f.aktivitaet",
  "f.drucksache",
  "f.id",
  "f.person_id",
  "f.plenarprotokoll",
  "f.vorgang",
  "f.vorgangsposition_id",
  "f.vorgangstyp_notation",
  "f.wahlperiode",
];

/**
 * Why `value` cannot be sent for one of the `INTEGER_FILTERS`, or `undefined`: a
 * non-negative safe integer, as a number or as a string of ASCII digits only (no sign,
 * no spaces, no `1e3` or `0x10`). The reason does not echo the value.
 */
export function integerFilterProblem(value: unknown): string | undefined {
  const ok =
    typeof value === "number"
      ? Number.isSafeInteger(value) && value >= 0
      : typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  return ok ? undefined : "Expected a non-negative whole number (digits only), e.g. 21.";
}

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

/** True when `params` sends a `cursor` and no other parameter. */
function bareCursor(params: Record<string, unknown>): boolean {
  const present = (key: string): boolean => params[key] !== undefined && params[key] !== null;
  return present("cursor") && !Object.keys(params).some((key) => key !== "cursor" && present(key));
}

/**
 * Why a list request that sends a `cursor` and no filter is refused, or `undefined`.
 * DIP does not bind a cursor to the query it came from: a cursor from a filtered page,
 * sent alone, pages through the whole unfiltered collection (page 2 of
 * `vorgangsposition` for one procedure came back as 100 positions of other procedures
 * from 2007, with HTTP 200). `list()` throws this as a `DipValidationError` unless
 * `allowUnfilteredCursor` is set; the CLI refuses a bare `--cursor` as a usage error.
 */
export function cursorWithoutFiltersProblem(resource: ListResource, params: Record<string, unknown>): string | undefined {
  if (!bareCursor(params)) return undefined;
  return (
    `A cursor without a filter pages through the whole unfiltered ${resource} list: DIP does ` +
    `not keep the filters of the page the cursor came from. Pass that page's filters again ` +
    `with the cursor, or set allowUnfilteredCursor to page the unfiltered list.`
  );
}

/**
 * A note for a list request that sends a `cursor` and no filter, or `undefined`, for a
 * caller that pages an unfiltered list on purpose (`allowUnfilteredCursor`).
 *
 * @deprecated The CLI no longer prints it: it refuses a bare `--cursor`, and `list()`
 * refuses a bare cursor unless `allowUnfilteredCursor` is set
 * ({@link cursorWithoutFiltersProblem}).
 */
export function cursorWithoutFiltersNote(resource: ListResource, params: Record<string, unknown>): string | undefined {
  if (!bareCursor(params)) return undefined;
  return (
    `--cursor without a filter pages through the whole unfiltered ${resource} list: DIP does not ` +
    `keep the filters of the page the cursor came from. If that page was filtered, repeat every ` +
    `--filter and --id of it together with --cursor.`
  );
}
