// Credentials kept in a file of their own: `dip config set api-key`.
//
// The key could only come from `--api-key`, which puts it into shell history and
// `ps`, or from `DIP_API_KEY`, which every shell, cron job and launcher has to export —
// people end up writing it into wrapper scripts. It now has a home of its own:
//
//   $XDG_CONFIG_HOME/dip-bundestag/credentials   (else ~/.config/dip-bundestag/credentials)
//
// one JSON object of name → value, mode 0600 in a directory of mode 0700, replaced
// atomically. An OS keychain is not used (yet): on servers, under cron, systemd and in
// containers it is usually locked or missing, and this file is what such a setup
// would fall back to anyway. The same mechanism as openka-cli's `ka config`.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DipError, DipUsageError } from "../client/errors.js";
import { apiKeyProblem } from "../client/client.js";
import { API_KEY_CREDENTIAL } from "./shared.js";

/** The directory under `$XDG_CONFIG_HOME` (or `~/.config`) this program keeps its credentials in. */
export const CONFIG_DIR_NAME = "dip-bundestag";

/** A credential's name: lower-case words joined by hyphens, like `api-key`. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Why `name` cannot name a credential, or undefined. */
export function credentialNameProblem(name: string): string | undefined {
  return NAME.test(name) ? undefined : "Not a credential name: expected lower-case words joined by hyphens, like api-key.";
}

/**
 * Why `value` cannot be stored as a credential, or undefined: blank, or holding
 * whitespace or control characters inside — a key is one token, and a stray newline
 * from a paste would be sent as part of a header.
 */
export function credentialValueProblem(value: string): string | undefined {
  if (value.trim() === "") return "The value is empty.";
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return "The value holds whitespace or control characters; a key is one token.";
  return undefined;
}

/**
 * Why `value` cannot be used as the credential `name`, or undefined:
 * `credentialValueProblem`, and for the API key also what an HTTP header cannot carry
 * (the library's `apiKeyProblem`). `config set` refuses such a value, and a value read
 * from the file is checked the same way (`CredentialStore.usable`).
 */
export function credentialProblem(name: string, value: string): string | undefined {
  return credentialValueProblem(value) ?? (name === API_KEY_CREDENTIAL ? apiKeyProblem(value) : undefined);
}

/**
 * Where the credentials file is: `$XDG_CONFIG_HOME/dip-bundestag/credentials`, else
 * `$HOME/.config/dip-bundestag/credentials` — `HOME` from `env` first, so a caller's
 * environment decides, and only then the system's home directory.
 */
export function resolveCredentialsPath(env: Record<string, string | undefined>): string {
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.trim() !== "" && isAbsolute(xdg)) return join(xdg, CONFIG_DIR_NAME, "credentials");
  const home = env["HOME"] !== undefined && env["HOME"].trim() !== "" ? env["HOME"] : homedir();
  return join(home, ".config", CONFIG_DIR_NAME, "credentials");
}

/** Below this length a key shows nothing of itself: eight of twelve characters is most of it. */
const MASK_MIN_LENGTH = 20;

/** True for a credential name whose value is a password: never partly shown. */
function isPasswordName(name: string | undefined): boolean {
  return name !== undefined && /(^|-)password$/.test(name);
}

/**
 * `abcd…wxyz`: enough to tell two keys apart, never enough to use one. A value shorter
 * than 20 characters, and a password whatever its length, shows nothing of itself, not
 * even its length: `****`.
 */
export function maskCredential(value: string, name?: string): string {
  return !isPasswordName(name) && value.length >= MASK_MIN_LENGTH ? `${value.slice(0, 4)}…${value.slice(-4)}` : "****";
}

/**
 * The credentials file. Reading it checks what ssh checks of a private key: a regular
 * file, owned by this user, readable by nobody else — anything else is a `DipError`
 * naming the fix, rather than a key quietly used from a file others can read.
 */
/** How long `set`/`unset` wait for another writer's lock before giving up (ms). */
export const LOCK_WAIT_MS = 2_000;
/** A lock older than this (ms) is left over from a crash and taken over. */
export const LOCK_STALE_MS = 30_000;
/** The wait between two attempts at the lock (ms). */
const LOCK_RETRY_MS = 50;

/** The clock and the (synchronous) wait of the lock, injectable for tests. */
export interface CredentialStoreOptions {
  /** Milliseconds since the epoch. Unset, `Date.now`. */
  now?: () => number;
  /** Block for `ms` milliseconds. Unset, a real wait. */
  sleep?: (ms: number) => void;
}

/** A synchronous wait: `set`/`unset` stay synchronous, and the wait is short. */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class CredentialStore {
  readonly path: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => void;

  constructor(path: string, options: CredentialStoreOptions = {}) {
    this.path = resolve(path);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? blockFor;
  }

  /** The store at `resolveCredentialsPath(env)`. */
  static fromEnv(env: Record<string, string | undefined>): CredentialStore {
    return new CredentialStore(resolveCredentialsPath(env));
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  /**
   * The value of `name` for use: trimmed, and a value `config set` would refuse (the
   * file was edited by hand: blank, a line break, an escape sequence, a character no
   * header can carry) is a `DipError` naming the file and the fix. Without the check a
   * blank value sent no key while the cleartext warning said one was sent, a bad one
   * failed as `Invalid apiKey` (a usage error the user never made), and `config list`
   * printed control characters raw.
   */
  usable(name: string): string | undefined {
    const raw = this.get(name);
    if (raw === undefined) return undefined;
    const value = raw.trim();
    const reason = credentialProblem(name, value);
    if (reason !== undefined) {
      throw new DipError(`The ${name} stored in ${this.path} cannot be used: ${reason} dip config set ${name} replaces it.`);
    }
    return value;
  }

  /** Every stored name, sorted. */
  names(): string[] {
    return Object.keys(this.read()).sort();
  }

  /**
   * Every stored name, sorted, each a credential name: a hand-edited name that is not
   * one (it may hold control characters) is a `DipError` naming the file.
   */
  usableNames(): string[] {
    const names = this.names();
    for (const name of names) {
      if (credentialNameProblem(name) !== undefined) {
        throw new DipError(`The credentials file ${this.path} holds ${JSON.stringify(name)}, which is not a credential name; remove it by hand.`);
      }
    }
    return names;
  }

  set(name: string, value: string): void {
    const nameReason = credentialNameProblem(name);
    if (nameReason !== undefined) throw new DipUsageError(nameReason);
    const valueReason = credentialValueProblem(value);
    if (valueReason !== undefined) throw new DipUsageError(valueReason);
    this.locked(() => this.write({ ...this.read(), [name]: value }));
  }

  /** Remove `name`; false when it was not stored. The file goes when nothing is left in it. */
  unset(name: string): boolean {
    // Nothing to remove: no lock, and no directory created for it.
    if (!(name in this.read())) return false;
    return this.locked(() => {
      const all = this.read();
      if (!(name in all)) return false;
      delete all[name];
      if (Object.keys(all).length === 0) {
        try {
          rmSync(this.path, { force: true });
        } catch (err) {
          throw this.writeError(err);
        }
        return true;
      }
      this.write(all);
      return true;
    });
  }

  /**
   * Run `fn` (a read-modify-write) holding `credentials.lock` beside the file, so two
   * `config set` at the same time cannot both log "Stored" while one value is lost. The
   * lock is created exclusively; a held one is retried for `LOCK_WAIT_MS`, then the
   * call fails ("Another dip config is writing …; try again") and nothing is changed. A
   * lock older than `LOCK_STALE_MS` was left by a crash and is taken over.
   */
  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    try {
      // Inside the try: an unwritable config location is named like any write failure.
      this.ensureDirectory();
    } catch (err) {
      throw this.writeError(err);
    }
    const start = this.#now();
    for (;;) {
      try {
        writeFileSync(lock, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
        break;
      } catch (err) {
        if ((err as { code?: unknown }).code !== "EEXIST") throw this.writeError(err);
      }
      let age: number | undefined;
      try {
        age = this.#now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released in the meantime: try again at once
      }
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (this.#now() - start >= LOCK_WAIT_MS) {
        throw new DipError(`Another dip config is writing ${this.path}; try again.`);
      }
      this.#sleep(LOCK_RETRY_MS);
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** The file's directory, created with mode 0700, and tightened to it when others could read it. */
  private ensureDirectory(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }

  private read(): Record<string, string> {
    // lstat, not exists: a link — dangling or not — is refused, not taken for "no file".
    let stats;
    try {
      stats = lstatSync(this.path);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return {};
      throw new DipError(`Could not read the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!stats.isFile()) throw new DipError(`${this.path} is not a regular file; it cannot be the credentials file.`);
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new DipError(`The credentials file ${this.path} belongs to another user; it is not read.`);
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new DipError(
          `The credentials file ${this.path} can be read by others (mode ${(stats.mode & 0o777).toString(8)}); ` +
            `it is not used until only you can: chmod 600 ${this.path}`,
        );
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new DipError(`The credentials file ${this.path} is not valid JSON; fix it, or remove it and set the values again.`, { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
      throw new DipError(`The credentials file ${this.path} is not an object of names and strings.`);
    }
    return { ...(parsed as Record<string, string>) };
  }

  /**
   * Replace the file atomically: a temporary file beside it, created with mode 0600
   * and exclusively, renamed over it. A crash leaves the old file or the new one,
   * never half of either, and at no moment is the key in a file others can read.
   */
  private write(all: Record<string, string>): void {
    const temporary = `${this.path}.tmp-${process.pid}`;
    const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    try {
      // Inside the try: an unwritable config location (EACCES on mkdir or chmod) is
      // reported like any other write failure, naming the file.
      this.ensureDirectory();
      // Left by a run of the same pid that crashed between the two steps.
      rmSync(temporary, { force: true });
      writeFileSync(temporary, JSON.stringify(sorted, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } catch (err) {
      rmSync(temporary, { force: true });
      throw this.writeError(err);
    }
  }

  /** "Could not write the credentials file <path>: <reason>", the cause kept. */
  private writeError(err: unknown): DipError {
    return new DipError(`Could not write the credentials file ${this.path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
