import type { Command } from "commander";
import { logOf, type CliDeps } from "../io.js";
import {
  API_KEY_ENV_VAR,
  HELP_PAGE_URL,
  KEY_CONTACT,
  obtainKey,
  shellQuoteSingle,
} from "@maschinenlesbar.org/dip-bundestag-client/internal/obtain-key";
import { toEngineOptions, warnIfCleartext, type GlobalOptions } from "../shared.js";
import { DEFAULT_BASE_URL } from "@maschinenlesbar.org/dip-bundestag-client/internal/engine";
import { DipUsageError, redactUrl } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";

/**
 * `obtain-key` — read the published DIP key, prove it works, and print it.
 *
 * Deliberately does NOT build a client: it must work before a key exists. stdout
 * carries only the key (so `$(...)` composes); everything else goes to stderr.
 */
export function registerObtainKeyCommands(program: Command, deps: CliDeps): void {
  program
    .command("obtain-key")
    .description(
      "Obtain the DIP API key and check it still works. DIP rotates its published key, " +
        `so the candidate is verified against the live API before it is printed; if no ` +
        `published key is accepted the command fails and points at ${HELP_PAGE_URL}.`,
    )
    .option("--export", `print "export ${API_KEY_ENV_VAR}=<key>" for use with eval`)
    .option("--no-verify", "skip the live check and print the published candidate unchecked")
    .action(async (...args: unknown[]) => {
      const command = args[args.length - 1] as Command;
      const global = command.optsWithGlobals() as GlobalOptions;
      const opts = command.opts();
      // The key goes to stdout only (so `$(...)` and `--export >> ~/.zshrc` compose);
      // silently ignoring -o would put it on the terminal although a file was asked for.
      if (global.output !== undefined && global.output !== "-") {
        throw new DipUsageError(
          "obtain-key does not write files: it prints the key on stdout, so redirect that " +
            "instead of using --output.",
        );
      }
      const baseUrl = (global.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
      // Every global request option the client gets (base URL, timeout, size cap,
      // User-Agent, retries) goes to obtainKey too; only the key, which this
      // command looks for, is left out.
      const { apiKey: _apiKey, ...requestOptions } = toEngineOptions(global);
      // Only the verification goes to the base URL (the key is read from DIP's fixed
      // https help page), and it sends the candidate key.
      if (opts["verify"] !== false) warnIfCleartext(deps, global.baseUrl, true);
      const { key, sourceUrl, verified } = await obtainKey({
        ...requestOptions,
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
        verify: opts["verify"] !== false,
      });
      const log = logOf(deps);
      if (verified) {
        log.info(
          "obtain-key",
          baseUrl === DEFAULT_BASE_URL
            ? `Obtained the key from ${sourceUrl} and verified it against the live API.`
            : `Obtained the key from ${sourceUrl} and verified it against ${redactUrl(baseUrl)} ` +
              `(--base-url), not against the live DIP API.`,
        );
      } else {
        // A WARN, not an INFO: a log filter on WARN and up must see that the key was never checked.
        log.warn(
          "obtain-key",
          `Obtained the key from ${sourceUrl} WITHOUT verifying it. DIP rotates its ` +
            `published key; if DIP answers 401, get the current one from ` +
            `${HELP_PAGE_URL} or request a personal key from ${KEY_CONTACT}.`,
        );
      }
      deps.io.out(opts["export"] ? `export ${API_KEY_ENV_VAR}=${shellQuoteSingle(key)}` : key);
    });
}
