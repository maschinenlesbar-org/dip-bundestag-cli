// DipClient — a typed client over the Bundestag DIP API
// (https://search.dip.bundestag.de/api/v1), the federal parliament's
// documentation and information system for parliamentary materials.
//
// Auth: an API key sent as `Authorization: ApiKey <key>`. No key is bundled with
// this client — pass it via `apiKey` (CLI: `--api-key` / `DIP_API_KEY`). When no
// key is supplied the header is omitted and the API answers 401. The Bundestag
// publishes a shared key (rate-limited, rotates yearly); request a personal key
// from parlamentsdokumentation@bundestag.de. For CI / live testing the shared
// key can be fetched out-of-band via scripts/fetch-api-key.mjs.
//
//   client.vorgaenge.list({ "f.titel": "Klimaschutz" })
//   client.drucksachen.get("123456")

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import type { ListResult, Document } from "./types.js";

const API = "/api/v1";
const enc = encodeURIComponent;

/** Options for the DIP client (engine options plus the API key). */
export interface DipClientOptions extends EngineOptions {
  /**
   * The DIP API key, sent as `Authorization: ApiKey <key>`. No key is bundled;
   * when omitted (or blank) the header is not sent. Obtain a key from the
   * Bundestag, or fetch the shared key via scripts/fetch-api-key.mjs.
   */
  apiKey?: string;
}

/** A DIP resource: cursor-paginated `list` plus `get` by id. */
class ResourceGroup {
  constructor(
    private readonly e: RequestEngine,
    private readonly path: string,
  ) {}

  /** List/filter documents. Pass DIP `f.*` filters and/or a `cursor`. */
  list(params: QueryParams = {}): Promise<ListResult> {
    return this.e.getJson(`${API}/${this.path}`, params);
  }

  /** A single document by id. */
  get(id: string): Promise<Document> {
    return this.e.getJson(`${API}/${this.path}/${enc(id)}`);
  }
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
    const { apiKey, ...engineOptions } = options;
    // Only send Authorization when a non-blank key was supplied; never default one.
    const key = apiKey?.trim() ? apiKey : undefined;
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
