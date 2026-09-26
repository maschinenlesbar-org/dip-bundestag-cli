// Registers the DIP resource command groups. They are structurally identical
// (`list` + `get <id>`), so they are generated from a table.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseNonEmpty, renderJson } from "../shared.js";
import { DipUsageError } from "../../client/errors.js";
import type { DipClient } from "../../client/client.js";
import type { QueryParams } from "../../client/query.js";
import { LIST_FILTERS, type ListResource } from "../../client/filters.js";

type ResourceKey =
  | "vorgaenge"
  | "vorgangspositionen"
  | "drucksachen"
  | "drucksacheText"
  | "plenarprotokolle"
  | "plenarprotokollText"
  | "aktivitaeten"
  | "personen";

interface ResourceSpec {
  /** The command name, which is also the endpoint's path segment under /api/v1. */
  command: ListResource;
  resource: ResourceKey;
  description: string;
}

const RESOURCES: ResourceSpec[] = [
  { command: "vorgang", resource: "vorgaenge", description: "Vorgänge (procedures)" },
  { command: "vorgangsposition", resource: "vorgangspositionen", description: "Vorgangspositionen" },
  { command: "drucksache", resource: "drucksachen", description: "Drucksachen (printed papers)" },
  { command: "drucksache-text", resource: "drucksacheText", description: "Drucksachen with full text" },
  { command: "plenarprotokoll", resource: "plenarprotokolle", description: "Plenarprotokolle" },
  {
    command: "plenarprotokoll-text",
    resource: "plenarprotokollText",
    description: "Plenarprotokolle with full text",
  },
  { command: "aktivitaet", resource: "aktivitaeten", description: "Aktivitäten" },
  { command: "person", resource: "personen", description: "Personen (members)" },
];

/**
 * commander accumulator for repeatable, non-blank string options (`--id`). Each
 * value is validated so a blank id is a usage error rather than being dropped.
 */
function collectNonEmpty(value: string, previous: string[] = []): string[] {
  return previous.concat([parseNonEmpty(value)]);
}

type FilterMap = Record<string, string[]>;

/**
 * Build the commander accumulator for one resource's repeatable `key=value`
 * filters.
 *
 * The key must be one of the resource's documented `f.*` filters: DIP ignores an
 * unknown one and answers with the whole unfiltered list, so a typo (`f.titl`) or a
 * filter of another resource (`f.person` on `vorgang`) would silently widen the
 * query. Repeated occurrences of the same key are accumulated into a list (the DIP
 * API supports repeated query keys) rather than letting the last value silently
 * clobber the earlier ones — mirroring how `--id`/`f.id` are merged below.
 */
function filterCollector(resource: ListResource): (value: string, previous?: FilterMap) => FilterMap {
  const known = LIST_FILTERS[resource];
  return (value, previous = {}) => {
    const [key, val] = splitFilter(value);
    if (key === "cursor") {
      throw new InvalidArgumentError(
        `"cursor" is a paging or sorting parameter, not a filter. Use --cursor on list instead.`,
      );
    }
    if (!known.includes(key)) {
      throw new InvalidArgumentError(
        `Unknown filter "${key}" for ${resource}. DIP ignores unknown filters and would ` +
          `return the whole unfiltered list. Filters for ${resource}: ${known.join(", ")}.`,
      );
    }
    return { ...previous, [key]: (previous[key] ?? []).concat([val]) };
  };
}

/** Split and check one `--filter key=value` argument. */
function splitFilter(value: string): [string, string] {
  const eq = value.indexOf("=");
  // Throw commander's InvalidArgumentError (not a bare DipError) so the usual
  // parse-error path runs and showHelpAfterError() displays the command help,
  // matching how commander reports its own option errors.
  if (eq <= 0) throw new InvalidArgumentError(`Invalid --filter "${value}". Expected key=value.`);
  const key = value.slice(0, eq);
  const val = value.slice(eq + 1);
  // A blank key or value would be dropped (f.id) or sent as an empty parameter,
  // so the list would silently run without that filter.
  if (key.trim() === "" || val.trim() === "") {
    throw new InvalidArgumentError(
      `Invalid --filter "${value}". Both key and value must be non-empty.`,
    );
  }
  return [key, val];
}

export function registerResourceCommands(program: Command, deps: CliDeps): void {
  for (const spec of RESOURCES) {
    const group = program.command(spec.command).description(spec.description);

    group
      .command("list")
      .description(`List/filter ${spec.command}`)
      .option("--cursor <cursor>", "pagination cursor from a previous page", parseNonEmpty)
      .option("--id <id>", "filter by id (repeatable -> f.id)", collectNonEmpty)
      .option(
        "--filter <key=value>",
        `DIP filter, e.g. f.titel=Klima (repeatable; one of ${spec.command}'s f.* filters)`,
        filterCollector(spec.command),
      )
      .action(
        action(deps, async ({ client, global, opts }) => {
          const filter = opts["filter"] as FilterMap | undefined;
          const params: QueryParams = { ...filter };
          // A blank --cursor is rejected at parse time (parseNonEmpty).
          const cursor = opts["cursor"] as string | undefined;
          if (cursor !== undefined) params["cursor"] = cursor;
          // --id and --filter f.id=... both target the f.id query key. Rather than
          // letting one silently clobber the other, merge them: any f.id supplied
          // via --filter is combined with the repeatable --id values. Blank ids
          // and blank filter values are rejected at parse time.
          const ids = opts["id"] as string[] | undefined;
          const fromFilter = filter?.["f.id"];
          const mergedIds = [...(fromFilter ?? []), ...(ids ?? [])];
          if (mergedIds.length > 0) params["f.id"] = mergedIds;
          else delete params["f.id"];
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.list(params));
        }),
      );

    group
      .command("get <id>")
      .description(`Get one ${spec.command} by id`)
      .action(
        action(deps, async ({ client, global }, [id]) => {
          // An empty/whitespace-only id would hit the collection endpoint
          // (.../vorgang/) and silently target the wrong resource shape; reject it.
          if (id === undefined || id.trim().length === 0) {
            throw new DipUsageError("An id is required, e.g. `vorgang get 123456`.");
          }
          // "." and ".." survive encodeURIComponent and URL parsing resolves them,
          // so `get .` would fetch the whole list and `get ..` the API root.
          if (id === "." || id === "..") {
            throw new DipUsageError(`Invalid id "${id}": "." and ".." cannot be used as an id.`);
          }
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.get(id));
        }),
      );
  }
}
