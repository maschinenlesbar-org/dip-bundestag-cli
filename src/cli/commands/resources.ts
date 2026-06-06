// Registers the DIP resource command groups. They are structurally identical
// (`list` + `get <id>`), so they are generated from a table.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import { DipError } from "../../client/errors.js";
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

/** commander accumulator for repeatable `key=value` filters into a record. */
function collectFilter(
  value: string,
  previous: Record<string, string> = {},
): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0) throw new DipError(`Invalid --filter "${value}". Expected key=value.`);
  return { ...previous, [value.slice(0, eq)]: value.slice(eq + 1) };
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
          const filter = opts["filter"] as Record<string, string> | undefined;
          const params: QueryParams = { ...filter };
          if (opts["cursor"] !== undefined) params["cursor"] = opts["cursor"] as string;
          // --id and --filter f.id=... both target the f.id query key. Rather than
          // letting one silently clobber the other, merge them: any f.id supplied
          // via --filter is combined with the repeatable --id values.
          const ids = opts["id"] as string[] | undefined;
          if (ids !== undefined) {
            const fromFilter = filter?.["f.id"];
            params["f.id"] = fromFilter !== undefined ? [fromFilter, ...ids] : ids;
          }
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.list(params));
        }),
      );

    group
      .command("get <id>")
      .description(`Get one ${spec.command} by id`)
      .action(
        action(deps, async ({ client, global }, [id]) => {
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.get(id!));
        }),
      );
  }
}
