// The `f.*` filters each DIP list endpoint accepts, from the official OpenAPI
// description (https://search.dip.bundestag.de/api/v1/openapi.yaml, version 1.5,
// read 2026-09-26).
//
// DIP ignores a query parameter it does not know: `vorgang list` with a mistyped
// `f.titl=Klima`, or with `f.person` (which only `person`/`aktivitaet` have),
// answers with the whole unfiltered list and HTTP 200. Callers that take filter
// names from users (the CLI's `--filter`) check them against this table, because
// nothing downstream will. The library's `list(params)` itself passes any key on.

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
