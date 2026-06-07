// Registers the DIP resource command groups. They are structurally identical
// (`list` + `get <id>`), so they are generated from a table.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import { DipUsageError } from "../../client/errors.js";
import type { DipClient } from "../../client/client.js";
import type { QueryParams } from "../../client/query.js";

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
  command: string;
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

/** commander accumulator for repeatable string options. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

type FilterMap = Record<string, string[]>;

/**
 * commander accumulator for repeatable `key=value` filters.
 *
 * Repeated occurrences of the same key are accumulated into a list (the DIP API
 * supports repeated query keys) rather than letting the last value silently
 * clobber the earlier ones — mirroring how `--id`/`f.id` are merged below.
 */
function collectFilter(value: string, previous: FilterMap = {}): FilterMap {
  const eq = value.indexOf("=");
  // Throw commander's InvalidArgumentError (not a bare DipError) so the usual
  // parse-error path runs and showHelpAfterError() displays the command help,
  // matching how commander reports its own option errors.
  if (eq <= 0) throw new InvalidArgumentError(`Invalid --filter "${value}". Expected key=value.`);
  const key = value.slice(0, eq);
  const val = value.slice(eq + 1);
  return { ...previous, [key]: (previous[key] ?? []).concat([val]) };
}

export function registerResourceCommands(program: Command, deps: CliDeps): void {
  for (const spec of RESOURCES) {
    const group = program.command(spec.command).description(spec.description);

    group
      .command("list")
      .description(`List/filter ${spec.command}`)
      .option("--cursor <cursor>", "pagination cursor from a previous page")
      .option("--id <id>", "filter by id (repeatable -> f.id)", collect)
      .option("--filter <key=value>", "raw DIP filter, e.g. f.titel=Klima (repeatable)", collectFilter)
      .action(
        action(deps, async ({ client, global, opts }) => {
          const filter = opts["filter"] as FilterMap | undefined;
          const params: QueryParams = { ...filter };
          // Omit an empty/blank --cursor rather than sending a stray `cursor=`.
          const cursor = opts["cursor"] as string | undefined;
          if (cursor !== undefined && cursor.length > 0) params["cursor"] = cursor;
          // --id and --filter f.id=... both target the f.id query key. Rather than
          // letting one silently clobber the other, merge them: any f.id supplied
          // via --filter is combined with the repeatable --id values. Empty ids
          // are dropped so they never produce a stray `f.id=`.
          const ids = (opts["id"] as string[] | undefined)?.filter((id) => id.length > 0);
          const fromFilter = filter?.["f.id"]?.filter((id) => id.length > 0);
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
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.get(id));
        }),
      );
  }
}
