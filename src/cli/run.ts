// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  DipApiError,
  DipError,
  DipUsageError,
  DipValidationError,
  credentialsIn,
  redactCredentials,
  redactSecrets,
} from "../client/errors.js";
import { API_KEY_ENV_VAR, looksLikeApiKey } from "../client/obtain-key.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/**
 * `deps` with an `io` that keeps the secrets of this run out of everything it
 * prints. Commander echoes a rejected value in its usage errors (`option '--api-key
 * <key>' argument '<the key>' is invalid`), and names an unknown command or option as
 * typed, so whatever path a secret takes to the terminal it is replaced:
 *
 * - the userinfo of every URL-like argument, `--opt=value` value and of the key
 *   variable (as `credentialsIn` finds it, parseable or not) becomes `***@`, on stdout
 *   and stderr;
 * - the value of `--api-key` (both forms), the `DIP_API_KEY` value and any argument
 *   shaped like a DIP key (`looksLikeApiKey`: a key typed without `--api-key`)
 *   become `***` on stderr. Not on stdout: `obtain-key` prints the key there, and it
 *   may well be the one already in `DIP_API_KEY`.
 *
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the
 * exact strings can. Without secrets the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const env = deps.env ?? process.env;
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  for (const source of [...argv, ...values, envKey]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  const keys = new Set<string>();
  const addKey = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const form of [value, value.trim()]) {
      keys.add(form);
      keys.add(JSON.stringify(form).slice(1, -1));
    }
  };
  addKey(envKey);
  argv.forEach((token, i) => {
    if (SECRET_FLAGS.includes(token)) addKey(argv[i + 1]);
    const eq = token.indexOf("=");
    if (eq > 0 && SECRET_FLAGS.includes(token.slice(0, eq))) addKey(token.slice(eq + 1));
  });
  for (const value of values) if (looksLikeApiKey(value)) addKey(value);
  if (userinfo.size === 0 && [...keys].every((k) => k.trim().length < 4)) return deps;
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const keyList = [...keys].sort((a, b) => b.length - a.length);
  const redactOut = (text: string): string => redactCredentials(text, urlList);
  const redactErr = (text: string): string => redactSecrets(redactOut(text), keyList);
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redactOut(text)), err: (text) => deps.io.err(redactErr(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse/usage errors map to the
      // conventional usage exit code 2 so scripts can tell a usage error apart
      // from a runtime error (1) or a 404 (4).
      return err.exitCode === 0 ? 0 : 2;
    }
    if (err instanceof DipApiError) {
      deps.io.err(`Error: ${err.message}`);
      // A 401 is almost always a key problem: either no key was supplied (no key
      // is bundled, so the request went out with no Authorization header) or the
      // supplied key is invalid/expired. Point the user at how to supply a valid
      // one rather than leaving them with a bare 401.
      if (err.status === 401) {
        deps.io.err(
          "Authentication failed (401). Check your API key, or if none was set " +
            "pass --api-key <key> or set DIP_API_KEY. The current public key is " +
            "published at https://dip.bundestag.de/über-dip/hilfe/api; a personal " +
            "key can be requested from parlamentsdokumentation@bundestag.de.",
        );
      }
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof DipValidationError || err instanceof DipUsageError) {
      // A usage error detected in an action, or the library rejecting an input
      // before any request (DipValidationError extends DipUsageError; named here
      // for clarity): exit 2, matching commander's own usage/parse errors.
      deps.io.err(`Error: ${err.message}`);
      return 2;
    }
    if (err instanceof DipError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
