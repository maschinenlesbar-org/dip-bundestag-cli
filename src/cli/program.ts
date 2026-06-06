// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { DipClient } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerResourceCommands } from "./commands/resources.js";

export const VERSION = "1.0.0";

/** Default dependencies: real client + real stdout/stderr/filesystem + real env. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new DipClient(options),
  env: process.env,
};

/**
 * Read DIP_API_KEY from the given environment, trimmed. A missing, empty, or
 * whitespace-only value is treated as unset (returns undefined) so it never
 * produces a malformed `Authorization: ApiKey  ` header.
 */
export function readEnvApiKey(env: Record<string, string | undefined>): string | undefined {
  const raw = env["DIP_API_KEY"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("dip")
    .description(
      "CLI for the Bundestag DIP API (https://search.dip.bundestag.de/api/v1) — " +
        "Vorgänge, Drucksachen, Plenarprotokolle, Aktivitäten and Personen. " +
        "Needs an API key: pass --api-key or set DIP_API_KEY (a personal key is " +
        "available from parlamentsdokumentation@bundestag.de).",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", "https://search.dip.bundestag.de")
    .option("--api-key <key>", "DIP API key (env: DIP_API_KEY)")
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .option("-o, --output <file>", "for downloads: write bytes to this file instead of stdout")
    .showHelpAfterError();

  // Seed --api-key from DIP_API_KEY (trimmed; blank treated as unset). commander
  // treats this as the option's value, which an explicit --api-key on the command
  // line overrides during parse, giving precedence: --api-key > DIP_API_KEY > default.
  const envKey = readEnvApiKey(deps.env ?? process.env);
  if (envKey !== undefined) program.setOptionValue("apiKey", envKey);

  registerResourceCommands(program, deps);

  return program;
}
