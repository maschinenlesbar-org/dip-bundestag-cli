// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import {
  DipApiError,
  DipError,
  DipNetworkError,
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
    // commander's own messages are log records too: its "error: …" an ERROR, the help it
    // shows after one an INFO.
    writeErr: (str) => {
      const text = str.replace(/\n$/, "");
      // The blank line commander writes between an error and the help it shows after.
      if (text === "") return;
      if (text.startsWith("error: ")) logOf(deps).error("cli", text.slice("error: ".length));
      else logOf(deps).info("cli", text);
    },
  });
  if (command.commands.length > 0) addHelpCommand(command);
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Replace commander's built-in `help [command]` with one that resolves every name it
 * is given. The built-in one looked at the first name only: `dip help nope` printed
 * the root help with exit 2 and no word about "nope", and `dip help vorgang nope`
 * printed the vorgang help with exit 0. Now `help a b …` shows the help of `a b`, and
 * an unknown name is reported exactly as `dip a nope` reports it (`error: unknown
 * command 'nope'`, redacted like all output, the usage exit code): the remaining names
 * are parsed by the command they were meant for, which raises commander's own error.
 * Added here rather than in `buildProgram`, so the command tree the website documents
 * stays as commander builds it.
 */
function addHelpCommand(command: Command): void {
  command.helpCommand(false);
  command
    .command("help [command...]")
    .description("display help for command")
    .action(async (names: string[]) => {
      let target = command;
      for (const [i, name] of names.entries()) {
        const sub = target.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (sub === undefined) {
          await target.parseAsync(names.slice(i), { from: "user" });
          return;
        }
        target = sub;
      }
      target.help();
    });
}

/** The options whose value is a secret on its own (no `@` to anchor a redaction on). */
const SECRET_FLAGS = ["--api-key"];

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL-like argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: that, and every secret value replaced (`***`). */
  err(text: string): string;
  /**
   * Make `value` a secret of the run from now on (on stderr), like a flag or env value:
   * for a secret the run learns after argv, such as the key read from the credentials file.
   */
  addSecret(value: string): void;
}

/**
 * The secrets of the run in `argv` and `env`. Commander echoes a rejected value in its
 * usage errors (`option '--api-key <key>' argument '<the key>' is invalid`), and names
 * an unknown command or option as typed, so whatever path a secret takes to the
 * terminal it is replaced:
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
 * exact strings can. Without secrets the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[], env: Record<string, string | undefined>): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const envKey = env[API_KEY_ENV_VAR] ?? "";
  const userinfo = new Set<string>();
  const keys = new Set<string>();
  const encodedUserinfo = new Set<string>();
  for (const source of [...argv, ...values, envKey]) {
    for (const secret of credentialsIn(source)) {
      userinfo.add(secret);
      userinfo.add(JSON.stringify(secret).slice(1, -1));
      // A URL typed as an id is echoed percent-encoded in a request path
      // (`/vorgang/https%3A%2F%2Falice%3Apw%40host`): no "@" to anchor on there.
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) encodedUserinfo.add(encoded);
    }
  }
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
  const urlList = [...userinfo];
  // Longest first, so a key is never left half-replaced by one of its own substrings.
  const sortedKeys = (): string[] => [...keys].sort((a, b) => b.length - a.length);
  let keyList = sortedKeys();
  const encodedList = [...encodedUserinfo];
  const out = (text: string): string => redactSecrets(redactCredentials(text, urlList), encodedList);
  return {
    out,
    err: (text) => redactSecrets(out(text), keyList),
    addSecret: (value) => {
      addKey(value);
      keyList = sortedKeys();
    },
  };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv, deps.env ?? process.env);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), outRaw: deps.io.outRaw ?? out, err: (text) => err(redaction.err(text)) },
    addSecret: redaction.addSecret,
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
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
    const log = logOf(deps);
    if (err instanceof DipApiError) {
      log.error("api", err.message);
      // A 401 is almost always a key problem: either no key was supplied (no key
      // is bundled, so the request went out with no Authorization header) or the
      // supplied key is invalid/expired. Point the user at how to supply a valid
      // one rather than leaving them with a bare 401.
      // When a redirect to another origin dropped the key, the message already says so
      // (an http: base URL redirected to https: is the usual case): the key is fine.
      if (err.status === 401 && err.credentialsDropped === undefined && deps.storedKeyPath !== undefined) {
        // The key came from the credentials file: most likely a stored public key that
        // DIP has since rotated. Say where it came from and how to replace it.
        log.info(
          "api",
          `Authentication failed (401) with the API key stored in ${deps.storedKeyPath}. DIP rotates ` +
            "its public key: `dip obtain-key | dip config set api-key` stores the current one " +
            "(--api-key and DIP_API_KEY take precedence over the file). A personal key can be " +
            "requested from parlamentsdokumentation@bundestag.de.",
        );
      } else if (err.status === 401 && err.credentialsDropped === undefined) {
        log.info(
          "api",
          "Authentication failed (401). Check your API key, or if none was set " +
            "pass --api-key <key>, set DIP_API_KEY, or store it with `dip config set api-key`. The current public key is " +
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
      log.error("cli", err.message);
      return 2;
    }
    if (err instanceof DipError) {
      log.error(err instanceof DipNetworkError ? "http" : "cli", err.message);
      return 1;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
