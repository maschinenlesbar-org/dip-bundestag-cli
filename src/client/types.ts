// Domain types for the Bundestag DIP API (search.dip.bundestag.de) —
// Dokumentations- und Informationssystem für Parlamentsmaterialien.
//
// List endpoints return a cursor-paginated envelope; the documents themselves are
// large and resource-specific, so they are exposed as faithful raw `JsonObject`s.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Cursor-paginated list envelope. */
export interface ListResult {
  numFound: number;
  documents: JsonObject[];
  /**
   * Opaque cursor; pass it back as `cursor` **together with the same filters** to fetch
   * the next page. DIP does not bind a cursor to its query: sent alone, it pages
   * through the whole unfiltered collection. It stops changing on the last page.
   */
  cursor?: string;
}

/** A single resource document. */
export type Document = JsonObject;
