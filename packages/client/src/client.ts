// DipClient — a typed client over the Bundestag DIP API
// (https://search.dip.bundestag.de/api/v1), the federal parliament's
// documentation and information system for parliamentary materials.
//
// Auth: an API key sent as `Authorization: ApiKey <key>`. No key is bundled with
// this client — pass it via `apiKey` (CLI: `--api-key` / `DIP_API_KEY`). When no
// key is supplied the header is omitted and the API answers 401. The Bundestag
// publishes a public key on https://dip.bundestag.de/über-dip/hilfe/api (renewed
// periodically); a personal key can be requested from
// parlamentsdokumentation@bundestag.de.
//
//   client.vorgaenge.list({ "f.titel": "Klimaschutz" })
//   client.drucksachen.get("123456")

import { API_PATH, RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams, QueryPrimitive } from "./query.js";
import type { ListResult, Document } from "./types.js";
import {
  INTEGER_FILTERS,
  LIST_FILTERS,
  TEXT_FILTERS,
  cursorWithoutFiltersProblem,
  filterKeyProblem,
  integerFilterProblem,
  type ListResource,
} from "./filters.js";
import {
  assertNonBlankParams,
  assertValid,
  documentProblem,
  headerValueProblem,
  idProblem,
  isBlank,
  isPlainObject,
  normalizeText,
  normalizeToken,
  listResultProblem,
  textProblem,
  tokenProblem,
  type Problem,
} from "./validate.js";
import { DipParseError, DipValidationError } from "./errors.js";

/**
 * `value` when `problem` accepts it, else a DipParseError naming the request
 * (`GET <url>: unexpected response shape: …`, userinfo redacted), as the engine's own
 * answer errors do.
 */
function expectShape<T>(value: unknown, problem: Problem<unknown>, request: string): T {
  const reason = problem(value);
  if (reason !== undefined) throw new DipParseError(`${request}: unexpected response shape: ${reason}.`);
  return value as T;
}

const API = API_PATH;
// Percent-encodes one path segment. It leaves "." and ".." unchanged; get()
// rejects those ids first (idProblem), and RequestEngine.buildUrl is a backstop.
const enc = encodeURIComponent;

/** Whether `key` is one of the filters DIP compares exactly (a code, a document number, a date). */
function isTokenFilter(key: string): boolean {
  return key.startsWith("f.") && ALL_FILTERS.has(key) && !TEXT_FILTERS.includes(key) && !INTEGER_FILTERS.includes(key);
}

/** Every filter of every resource. */
const ALL_FILTERS: ReadonlySet<string> = new Set(Object.values(LIST_FILTERS).flat());

/**
 * Refuse a string value that would match nothing, before any request: a text filter by
 * `textProblem` (and an unknown filter sent with `allowUnknownFilters`, whose kind is unknown),
 * a code, document number or date by `tokenProblem`. The cursor is opaque, and integer filters
 * have their own rule.
 */
function assertCanonicalValues(params: QueryParams): void {
  for (const [key, raw] of Object.entries(params)) {
    if (key === "cursor" || INTEGER_FILTERS.includes(key)) continue;
    const problem = isTokenFilter(key) ? tokenProblem : textProblem;
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value === "string") assertValid(key, value, problem);
    }
  }
}

/**
 * The query as DIP matches it, on a copy: every value of a text filter (`TEXT_FILTERS`)
 * trimmed and in composed Unicode (`normalizeText`; a value pasted with a trailing space, or
 * a decomposed "Bürgergeld", u + U+0308, found nothing), every code, document number and date
 * trimmed and composed too (`normalizeToken`; `f.dokumentnummer=20/6875 ` with a trailing space
 * found nothing), and every integer filter (`INTEGER_FILTERS`) without leading zeros: DIP
 * compares ids as text, so `f.id=0282486` found nothing where 282486 found the procedure. The
 * cursor is opaque and sent as given; an unknown filter (`allowUnknownFilters`) composed.
 */
function normaliseFilterValues(params: QueryParams): QueryParams {
  const composed = (value: QueryPrimitive): QueryPrimitive => (typeof value === "string" ? value.normalize("NFC") : value);
  const token = (value: QueryPrimitive): QueryPrimitive => (typeof value === "string" ? normalizeToken(value) : value);
  const text = (value: QueryPrimitive): QueryPrimitive => (typeof value === "string" ? normalizeText(value) : value);
  const integer = (value: QueryPrimitive): QueryPrimitive =>
    typeof value === "string" && /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, "") : value;
  // No prototype: with allowUnknownFilters a key such as `__proto__` stays a key.
  const out = Object.create(null) as QueryParams;
  for (const [key, value] of Object.entries(params)) {
    const one = INTEGER_FILTERS.includes(key) ? integer : TEXT_FILTERS.includes(key) ? text : isTokenFilter(key) ? token : composed;
    out[key] = key === "cursor" ? value : Array.isArray(value) ? value.map(one) : one(value);
  }
  return out;
}

/** Options for the DIP client (engine options plus the API key). */
export interface DipClientOptions extends EngineOptions {
  /**
   * The DIP API key, sent as `Authorization: ApiKey <key>`. No key is bundled;
   * when omitted (or blank) the header is not sent. The public key is published on
   * https://dip.bundestag.de/über-dip/hilfe/api; a personal key can be requested
   * from parlamentsdokumentation@bundestag.de.
   */
  apiKey?: string | undefined;
}

/** Options for `list()`. */
export interface ListOptions {
  /**
   * Send filter keys that are not in `LIST_FILTERS` for this resource, for a filter
   * DIP added after the table was read. Default `false`: an unknown key is
   * rejected, because DIP ignores it and returns the whole unfiltered list.
   */
  allowUnknownFilters?: boolean | undefined;
  /**
   * Send a `cursor` without any filter, to page through the whole unfiltered list on
   * purpose. Default `false`: a bare cursor is rejected, because DIP does not keep the
   * filters of the page the cursor came from, so a cursor from a filtered page sent
   * alone answers with unrelated records (`cursorWithoutFiltersProblem`).
   */
  allowUnfilteredCursor?: boolean | undefined;
}

/** A DIP resource: cursor-paginated `list` plus `get` by id. */
class ResourceGroup {
  constructor(
    private readonly e: RequestEngine,
    private readonly path: ListResource,
  ) {}

  /**
   * List/filter documents. Pass DIP `f.*` filters and/or a `cursor`. For the next
   * page, send the same filters again with the cursor: DIP does not bind a cursor to
   * its query, so a cursor alone pages through the whole unfiltered list. A cursor
   * without any filter is therefore rejected (`cursorWithoutFiltersProblem`) unless
   * `options.allowUnfilteredCursor` is set.
   *
   * Rejects with `DipValidationError`, before any request, for a blank parameter
   * name, a blank value, an empty array or a blank array element: DIP treats an
   * empty parameter as no filter and would answer with the whole unfiltered list.
   * `undefined`/`null` values are omitted. A 2xx answer that is not a list envelope
   * (`numFound`, `documents`) is a `DipParseError`. It also rejects a key that is not one
   * of the resource's filters (`LIST_FILTERS`) or `cursor`, which DIP would ignore
   * in the same way, unless `options.allowUnknownFilters` is set, and a value of an
   * integer filter (`INTEGER_FILTERS`: ids, `f.wahlperiode`, …) that is not a
   * non-negative whole number (`integerFilterProblem`).
   */
  async list(params: QueryParams = {}, options: ListOptions = {}): Promise<ListResult> {
    assertNonBlankParams(params);
    if (!isPlainObject(options)) throw new DipValidationError("Invalid options: Expected an object, e.g. { allowUnknownFilters: true }.");
    if (options.allowUnfilteredCursor !== true) {
      const bare = cursorWithoutFiltersProblem(this.path, params);
      if (bare !== undefined) throw new DipValidationError(`Invalid cursor: ${bare}`);
    }
    if (options.allowUnknownFilters !== true) {
      const problem = filterKeyProblem(this.path);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) assertValid("filter", key, problem);
      }
    }
    for (const key of INTEGER_FILTERS) {
      const value = params[key];
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined && one !== null) assertValid(key, one, integerFilterProblem);
      }
    }
    assertCanonicalValues(params);
    const path = `${API}/${this.path}`;
    const query = normaliseFilterValues(params);
    return expectShape<ListResult>(await this.e.getJson(path, query), listResultProblem, `GET ${this.e.describeUrl(path, query)}`);
  }

  /**
   * A single document by id. A string id is trimmed first (a copy-pasted
   * `"282486 "` used to be sent as `282486%20` and reported as not found). Rejects
   * with `DipValidationError`, before any request, for a blank id (`Invalid vorgang id: ...`), which would request the
   * collection endpoint and resolve with the list envelope, and for "." or "..",
   * which URL parsing resolves to the list or the API root. An all-digit id loses its
   * leading zeros, as an integer filter does: DIP compares ids as text, so `0282486`
   * was "not found" where `--id 0282486` found 282486. A 2xx answer that is not
   * a document (an object with an `id`) is a `DipParseError`.
   */
  async get(id: string): Promise<Document> {
    const trimmed = typeof id === "string" ? id.trim() : id;
    assertValid(`${this.path} id`, trimmed, idProblem);
    // Sent as a token (`normalizeToken`: trimmed, composed), an all-digit id without its leading zeros.
    const token = typeof trimmed === "string" ? normalizeToken(trimmed) : trimmed;
    const sent = typeof token === "string" && /^\d+$/.test(token) ? token.replace(/^0+(?=\d)/, "") : token;
    const path = `${API}/${this.path}/${enc(String(sent))}`;
    return expectShape<Document>(await this.e.getJson(path), documentProblem, `GET ${this.e.describeUrl(path)}`);
  }
}

/**
 * Why an API key cannot be sent, or `undefined`: after trimming, a key with a
 * control character or a character above U+00FF cannot be an HTTP header, and a key
 * is one token — whitespace inside (a tab or space from a paste) went out as part of
 * the header and ended in a 401, where the credentials file refused the same value.
 * A blank key is not a problem; it means "no key".
 */
export const apiKeyProblem: Problem<string> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return undefined;
  const key = value.trim();
  return headerValueProblem(key) ?? (/\s/.test(key) ? "The key holds whitespace inside; a key is one token." : undefined);
};

/**
 * The key the client sends: trimmed, a blank one counts as none (`undefined`).
 * Throws `DipValidationError` (`Invalid apiKey: ...`, never echoing the key) for
 * a key `apiKeyProblem` rejects. The CLI's `--api-key` and `DIP_API_KEY` paths
 * go through the same function, so all three send the same header.
 */
export function normaliseApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  assertValid("apiKey", value, apiKeyProblem);
  return value.trim() || undefined;
}

export class DipClient {
  private readonly engine: RequestEngine;

  readonly vorgaenge: ResourceGroup;
  readonly vorgangspositionen: ResourceGroup;
  readonly drucksachen: ResourceGroup;
  readonly drucksacheText: ResourceGroup;
  readonly plenarprotokolle: ResourceGroup;
  readonly plenarprotokollText: ResourceGroup;
  readonly aktivitaeten: ResourceGroup;
  readonly personen: ResourceGroup;

  constructor(options: DipClientOptions = {}) {
    // A JavaScript caller may pass null for "no options".
    options = options ?? {};
    if (!isPlainObject(options)) throw new DipValidationError("Invalid options: Expected an object.");
    const { apiKey, ...engineOptions } = options;
    if (engineOptions.defaultHeaders !== undefined && !isPlainObject(engineOptions.defaultHeaders)) {
      throw new DipValidationError("Invalid defaultHeaders: Expected an object of header names and values.");
    }
    // Only send Authorization when a non-blank key was supplied; never default one.
    const key = normaliseApiKey(apiKey);
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        ...(key ? { Authorization: `ApiKey ${key}` } : {}),
        ...engineOptions.defaultHeaders,
      },
    });

    this.vorgaenge = new ResourceGroup(this.engine, "vorgang");
    this.vorgangspositionen = new ResourceGroup(this.engine, "vorgangsposition");
    this.drucksachen = new ResourceGroup(this.engine, "drucksache");
    this.drucksacheText = new ResourceGroup(this.engine, "drucksache-text");
    this.plenarprotokolle = new ResourceGroup(this.engine, "plenarprotokoll");
    this.plenarprotokollText = new ResourceGroup(this.engine, "plenarprotokoll-text");
    this.aktivitaeten = new ResourceGroup(this.engine, "aktivitaet");
    this.personen = new ResourceGroup(this.engine, "person");
  }
}
