// DipClient — a typed client over the Bundestag DIP API
// (https://search.dip.bundestag.de/api/v1), the federal parliament's
// documentation and information system for parliamentary materials.
//
// Auth: an API key sent as `Authorization: ApiKey <key>`. The Bundestag
// publishes a shared key for testing (see DEFAULT_API_KEY); for anything beyond
// light use, request your own from parlamentsdokumentation@bundestag.de and pass
// it via `apiKey` (CLI: `--api-key` / `DIP_API_KEY`).
//
//   client.vorgaenge.list({ "f.titel": "Klimaschutz" })
//   client.drucksachen.get("123456")

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import type { ListResult, Document } from "./types.js";

const API = "/api/v1";
const enc = encodeURIComponent;

/**
 * The Bundestag's publicly-documented shared API key. It is rate-limited and
 * rotates roughly yearly (the last published value expired 2026-05-31), so set
 * your own via `apiKey` for reliable use.
 */
export const DEFAULT_API_KEY = "OSOegLs.PR2lwJ1dwCeje9vTj7FPOt3hvpYKtwKkhw";

/** Options for the DIP client (engine options plus the API key). */
export interface DipClientOptions extends EngineOptions {
  /** Overrides the default `Authorization: ApiKey` value. */
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
    this.engine = new RequestEngine({
      ...engineOptions,
      defaultHeaders: {
        Authorization: `ApiKey ${apiKey ?? DEFAULT_API_KEY}`,
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
