// Registers the DIP resource command groups. They are structurally identical
// (`list` + `get <id>`), so they are generated from a table.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import { action, parseNonEmpty, renderJson } from "../shared.js";
import type { DipClient } from "../../client/client.js";
import type { QueryParams } from "../../client/query.js";
import { cursorWithoutFiltersNote, filterKeyProblem, type ListResource } from "../../client/filters.js";
import { isBlank } from "../../client/validate.js";

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
  const problem = filterKeyProblem(resource);
  return (value, previous = {}) => {
    const [key, val] = splitFilter(value);
    // The library takes `cursor` in list(); on the command line it has its own option.
    if (key === "cursor") {
      throw new InvalidArgumentError(
        `"cursor" is a paging or sorting parameter, not a filter. Use --cursor on list instead.`,
      );
    }
    // The same check list() applies, checked here first for the usage error.
    const reason = problem(key);
    if (reason !== undefined) throw new InvalidArgumentError(reason);
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
  // so the list would silently run without that filter. The library's list()
  // rejects the same (assertNonBlankParams); this early check keeps the
  // --filter wording and commander's help.
  if (isBlank(key) || isBlank(val)) {
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
      .option(
        "--cursor <cursor>",
        "pagination cursor from a previous page; repeat that page's --filter/--id with it",
        parseNonEmpty,
      )
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
          const result = await resource.list(params);
          // A bare cursor is answered with unrelated records and HTTP 200; say so once
          // the request succeeded (a rejected one has its own error).
          const note = cursorWithoutFiltersNote(spec.command, params);
          if (note !== undefined) deps.io.err(`note: ${note}`);
          renderJson(deps, global, result);
        }),
      );

    group
      .command("get <id>")
      .description(`Get one ${spec.command} by id`)
      .action(
        action(deps, async ({ client, global }, [id = ""]) => {
          // A blank, "." or ".." id is rejected by the library's get()
          // (idProblem: DipValidationError, exit 2), before any request.
          const resource = client[spec.resource] as DipClient[ResourceKey];
          renderJson(deps, global, await resource.get(id));
        }),
      );
  }
}
