// Tiny, dependency-free query-string builder.
//   - `undefined` / `null` values are omitted entirely
//   - arrays are serialised as repeated keys (`?id=a&id=b`)
//   - booleans become the strings "true"/"false"
//   - Date values become full ISO-8601 strings
//   - everything else is coerced with String()

export type QueryPrimitive = string | number | boolean | Date | null | undefined;
export type QueryValue = QueryPrimitive | QueryPrimitive[];
export type QueryParams = Record<string, QueryValue>;

function serializeScalar(value: Exclude<QueryPrimitive, null | undefined>): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Build a query string (without a leading `?`) from a params object.
 * Returns an empty string when no parameters survive filtering.
 */
export function buildQueryString(params: QueryParams): string {
  const search = new URLSearchParams();

  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;

    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      search.append(key, serializeScalar(value));
    }
  }

  // URLSearchParams encodes spaces as "+"; "%20" is more broadly interoperable.
  return search.toString().replace(/\+/g, "%20");
}
