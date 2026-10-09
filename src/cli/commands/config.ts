// `dip config` — the API key kept in a credentials file of its own, the same
// mechanism as openka-cli's `ka config`. A key goes in through a prompt without echo
// or through stdin, never as an argument, so it reaches neither shell history nor
// `ps`; it comes out masked unless asked for in full.

import type { Command } from "commander";
import { DipError, DipUsageError } from "../../client/errors.js";
import { CONFIG_DIR_NAME, credentialProblem, maskCredential, type CredentialStore } from "../credentials.js";
import { logOf, type CliDeps } from "../io.js";
import { API_KEY_CREDENTIAL, type GlobalOptions } from "../shared.js";

/** The credentials this program knows. */
export const CREDENTIAL_NAMES = [API_KEY_CREDENTIAL] as const;

/**
 * The credential name a config command was given, checked in the action rather than by
 * a commander argument parser: commander repeats a rejected argument (`argument
 * 'abcSECRET…' is invalid`) and every surplus one (`too many arguments … got 2: …`), and
 * a key typed in place of the name would end up in the log. The usage errors here name
 * the valid names, never what was typed.
 */
function credentialNameArg(command: Command, usage: string): string {
  const [name, ...rest] = command.args;
  if (rest.length > 0) throw new DipUsageError(`${usage} takes one name: ${CREDENTIAL_NAMES.join(", ")}.`);
  if (name === undefined || !(CREDENTIAL_NAMES as readonly string[]).includes(name)) {
    throw new DipUsageError(`Not a credential name this program knows: expected ${CREDENTIAL_NAMES.join(", ")}.`);
  }
  return name;
}

function storeOf(deps: CliDeps): CredentialStore {
  if (deps.credentials === undefined) throw new DipError("This program was built without a credentials file.");
  return deps.credentials();
}

export function registerConfigCommands(program: Command, deps: CliDeps): void {
  const names = CREDENTIAL_NAMES.join(", ");
  const config = program
    .command("config")
    .description(`the API key, kept in a credentials file of its own: $XDG_CONFIG_HOME/${CONFIG_DIR_NAME}/credentials, else ~/.config/${CONFIG_DIR_NAME}/credentials (${names})`)
    // `config get --reveal -o key.txt` used to print the key on the terminal and write no
    // file. A secret written to a file is a job for `> file` and the user's own umask.
    .hook("preAction", (_config, command) => {
      const output = (command.optsWithGlobals() as GlobalOptions).output;
      if (output !== undefined && output !== "-") {
        throw new DipUsageError("dip config prints to stdout only: --output is refused; redirect stdout instead.");
      }
    });

  config
    .command("set")
    .description("store a credential: typed at a prompt without echo, or piped in (dip obtain-key | dip config set api-key) — never given as an argument")
    .argument("<name>", names)
    // Commander's own "too many arguments" error repeats them — here, the secret.
    .allowExcessArguments(true)
    .action(async (_name: string, _options: unknown, command: Command) => {
      if (command.args.length > 1) {
        throw new DipUsageError(
          "dip config set takes the name only: the value is read from a prompt or from stdin, never from the command line. " +
            "The one given is now in your shell history; if it is a secret, replace it there.",
        );
      }
      const name = credentialNameArg(command, "dip config set");
      if (deps.io.readSecret === undefined) throw new DipUsageError("No way to read a secret here: pipe it in, or run dip config set on a terminal.");
      const value = (await deps.io.readSecret(`${name}: `)).trim();
      const reason = credentialProblem(name, value);
      if (reason !== undefined) throw new DipUsageError(`${reason} Nothing was stored.`);
      const store = storeOf(deps);
      store.set(name, value);
      logOf(deps).info("config", `Stored ${name} (${maskCredential(value, name)}) in ${store.path}.`);
    });

  config
    .command("get")
    .description("show a stored credential, masked (abcd…wxyz, or **** below 20 characters) unless --reveal")
    .argument("<name>", names)
    .allowExcessArguments(true)
    .option("--reveal", "print the whole value, for a script that passes it on — it then is on your screen or in its log")
    .action(async (_name: string, options: { reveal?: boolean }, command: Command) => {
      const name = credentialNameArg(command, "dip config get");
      const store = storeOf(deps);
      const value = store.usable(name);
      if (value === undefined) throw new DipError(`No ${name} is stored in ${store.path}; dip config set ${name} stores one.`);
      deps.io.out(options.reveal === true ? value : maskCredential(value, name));
    });

  config
    .command("unset")
    .description("remove a stored credential")
    .argument("<name>", names)
    .allowExcessArguments(true)
    .action(async (_name: string, _options: unknown, command: Command) => {
      const name = credentialNameArg(command, "dip config unset");
      const store = storeOf(deps);
      if (!store.unset(name)) throw new DipError(`No ${name} is stored in ${store.path}.`);
      logOf(deps).info("config", `Removed ${name} from ${store.path}.`);
    });

  config
    .command("list")
    .description("every stored credential, masked, and where the file is")
    .allowExcessArguments(true)
    .action(async (_options: unknown, command: Command) => {
      if (command.args.length > 0) throw new DipUsageError("dip config list takes no arguments.");
      const store = storeOf(deps);
      // Checked first, so a bad entry prints nothing rather than half a list.
      const lines = store.usableNames().map((name) => `${name}  ${maskCredential(store.usable(name) as string, name)}`);
      for (const line of lines) deps.io.out(line);
      logOf(deps).info("config", `Credentials file: ${store.path}`);
    });
}
