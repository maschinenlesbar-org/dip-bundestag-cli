// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { DipApiError, DipError } from "../client/errors.js";

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

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      return err.exitCode;
    }
    if (err instanceof DipApiError) {
      deps.io.err(`Error: ${err.message}`);
      // A 401 is almost always a key problem. The bundled default key is the
      // Bundestag's public shared key, which is now expired, so point the user at
      // how to supply a working one rather than leaving them with a bare 401.
      if (err.status === 401) {
        deps.io.err(
          "Authentication failed (401). The bundled shared API key is expired. " +
            "Pass --api-key <key> or set DIP_API_KEY. Request a personal key from " +
            "parlamentsdokumentation@bundestag.de.",
        );
      }
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof DipError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
