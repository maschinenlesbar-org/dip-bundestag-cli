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
import type { QueryParams } from "./query.js";
import type { ListResult, Document } from "./types.js";
import {
  INTEGER_FILTERS,
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
  listResultProblem,
  type Problem,
} from "./validate.js";
import { DipParseError, DipValidationError } from "./errors.js";

/** `value` when `problem` accepts it, else a DipParseError naming the endpoint. */
function expectShape<T>(value: unknown, problem: Problem<unknown>, path: string): T {
  const reason = problem(value);
  if (reason !== undefined) throw new DipParseError(`Unexpected response from ${path}: ${reason}.`);
  return value as T;
}

const API = API_PATH;
// Percent-encodes one path segment. It leaves "." and ".." unchanged; get()
// rejects those ids first (idProblem), and RequestEngine.buildUrl is a backstop.
const enc = encodeURIComponent;

/** Options for the DIP client (engine options plus the API key). */
export interface DipClientOptions extends EngineOptions {
  /**
   * The DIP API key, sent as `Authorization: ApiKey <key>`. No key is bundled;
   * when omitted (or blank) the header is not sent. The public key is published on
   * https://dip.bundestag.de/über-dip/hilfe/api; a personal key can be requested
   * from parlamentsdokumentation@bundestag.de.
   */
  apiKey?: string;
}

/** Options for `list()`. */
export interface ListOptions {
  /**
   * Send filter keys that are not in `LIST_FILTERS` for this resource, for a filter
   * DIP added after the table was read. Default `false`: an unknown key is
   * rejected, because DIP ignores it and returns the whole unfiltered list.
   */
  allowUnknownFilters?: boolean;
  /**
   * Send a `cursor` without any filter, to page through the whole unfiltered list on
   * purpose. Default `false`: a bare cursor is rejected, because DIP does not keep the
   * filters of the page the cursor came from, so a cursor from a filtered page sent
   * alone answers with unrelated records (`cursorWithoutFiltersProblem`).
   */
  allowUnfilteredCursor?: boolean;
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
    const path = `${API}/${this.path}`;
    return expectShape<ListResult>(await this.e.getJson(path, params), listResultProblem, path);
  }

  /**
   * A single document by id. Rejects with `DipValidationError`, before any
   * request, for a blank id (`Invalid vorgang id: ...`), which would request the
   * collection endpoint and resolve with the list envelope, and for "." or "..",
   * which URL parsing resolves to the list or the API root. A 2xx answer that is not
   * a document (an object with an `id`) is a `DipParseError`.
   */
  async get(id: string): Promise<Document> {
    assertValid(`${this.path} id`, id, idProblem);
    const path = `${API}/${this.path}/${enc(String(id))}`;
    return expectShape<Document>(await this.e.getJson(path), documentProblem, path);
  }
}

/**
 * Why an API key cannot be sent, or `undefined`: after trimming, a key with a
 * control character (other than tab) or a character above U+00FF cannot be an
 * HTTP header. A blank key is not a problem; it means "no key".
 */
export const apiKeyProblem: Problem<string> = (value) =>
  typeof value !== "string" ? "Expected a string." : isBlank(value) ? undefined : headerValueProblem(value.trim());

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
