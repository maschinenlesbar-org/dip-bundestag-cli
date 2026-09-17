import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  API_KEY_ENV_VAR,
  HELP_PAGE_URL,
  KEY_CONTACT,
  obtainKey,
  shellQuoteSingle,
} from "../../client/obtain-key.js";
import type { GlobalOptions } from "../shared.js";

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
      const { key, sourceUrl, verified } = await obtainKey({
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
        ...(global.baseUrl !== undefined ? { baseUrl: global.baseUrl } : {}),
        ...(global.timeout !== undefined ? { timeoutMs: global.timeout } : {}),
        ...(global.userAgent !== undefined ? { userAgent: global.userAgent } : {}),
        verify: opts["verify"] !== false,
      });
      deps.io.err(
        verified
          ? `Obtained the key from ${sourceUrl} and verified it against the live API.`
          : `Obtained the key from ${sourceUrl} WITHOUT verifying it. DIP rotates its ` +
              `published key; if DIP answers 401, get the current one from ` +
              `${HELP_PAGE_URL} or request a personal key from ${KEY_CONTACT}.`,
      );
      deps.io.out(opts["export"] ? `export ${API_KEY_ENV_VAR}=${shellQuoteSingle(key)}` : key);
    });
}
