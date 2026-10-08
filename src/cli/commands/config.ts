// `dip config` — the API key kept in a credentials file of its own, the same
// mechanism as openka-cli's `ka config`. A key goes in through a prompt without echo
// or through stdin, never as an argument, so it reaches neither shell history nor
// `ps`; it comes out masked unless asked for in full.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { DipError, DipUsageError } from "../../client/errors.js";
import { apiKeyProblem } from "../../client/client.js";
import { CONFIG_DIR_NAME, credentialValueProblem, maskCredential, type CredentialStore } from "../credentials.js";
import type { CliDeps } from "../io.js";
import { API_KEY_CREDENTIAL } from "../shared.js";

/** The credentials this program knows. */
export const CREDENTIAL_NAMES = [API_KEY_CREDENTIAL] as const;

/** commander value-parser: a credential this program knows. */
function parseCredentialName(value: string): string {
  if (!(CREDENTIAL_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Not a credential: expected ${CREDENTIAL_NAMES.join(", ")}.`);
  }
  return value;
}

/** Why `value` cannot be stored under `name`, or undefined. */
function valueProblem(name: string, value: string): string | undefined {
  return credentialValueProblem(value) ?? (name === API_KEY_CREDENTIAL ? apiKeyProblem(value) : undefined);
}

function storeOf(deps: CliDeps): CredentialStore {
  if (deps.credentials === undefined) throw new DipError("This program was built without a credentials file.");
  return deps.credentials();
}

export function registerConfigCommands(program: Command, deps: CliDeps): void {
  const names = CREDENTIAL_NAMES.join(", ");
  const config = program
    .command("config")
    .description(`the API key, kept in a credentials file of its own: $XDG_CONFIG_HOME/${CONFIG_DIR_NAME}/credentials, else ~/.config/${CONFIG_DIR_NAME}/credentials (${names})`);

  config
    .command("set")
    .description("store a credential: typed at a prompt without echo, or piped in (dip obtain-key | dip config set api-key) — never given as an argument")
    .argument("<name>", names, parseCredentialName)
    // Commander's own "too many arguments" error repeats them — here, the secret.
    .allowExcessArguments(true)
    .action(async (name: string, _options: unknown, command: Command) => {
      if (command.args.length > 1) {
        throw new DipUsageError(
          "dip config set takes the name only: the value is read from a prompt or from stdin, never from the command line. " +
            "The one given is now in your shell history; if it is a secret, replace it there.",
        );
      }
      if (deps.io.readSecret === undefined) throw new DipUsageError("No way to read a secret here: pipe it in, or run dip config set on a terminal.");
      const value = (await deps.io.readSecret(`${name}: `)).trim();
      const reason = valueProblem(name, value);
      if (reason !== undefined) throw new DipUsageError(`${reason} Nothing was stored.`);
      const store = storeOf(deps);
      store.set(name, value);
      deps.io.err(`Stored ${name} (${maskCredential(value)}) in ${store.path}.`);
    });

  config
    .command("get")
    .description("show a stored credential, masked (abcd…wxyz) unless --reveal")
    .argument("<name>", names, parseCredentialName)
    .option("--reveal", "print the whole value, for a script that passes it on — it then is on your screen or in its log")
    .action(async (name: string, options: { reveal?: boolean }) => {
      const store = storeOf(deps);
      const value = store.get(name);
      if (value === undefined) throw new DipError(`No ${name} is stored in ${store.path}; dip config set ${name} stores one.`);
      deps.io.out(options.reveal === true ? value : maskCredential(value));
    });

  config
    .command("unset")
    .description("remove a stored credential")
    .argument("<name>", names, parseCredentialName)
    .action(async (name: string) => {
      const store = storeOf(deps);
      if (!store.unset(name)) throw new DipError(`No ${name} is stored in ${store.path}.`);
      deps.io.err(`Removed ${name} from ${store.path}.`);
    });

  config
    .command("list")
    .description("every stored credential, masked, and where the file is")
    .action(async () => {
      const store = storeOf(deps);
      for (const name of store.names()) deps.io.out(`${name}  ${maskCredential(store.get(name) as string)}`);
      deps.io.err(`Credentials file: ${store.path}`);
    });
}
