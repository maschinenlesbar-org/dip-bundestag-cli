// Credentials for an API that needs them (a key in a header, a login), the same in every
// repository (the kit). A repository whose API needs none exports nothing for it and nothing here
// changes how its server works. One whose API needs them exports `findCredentials` from api.ts:
// the server calls it once, at the first tool call that needs the client (not at start: the
// handshake, the tool list, a container's smoke test and the tests that start the bin never need
// the network or a credentials file), and builds the client with what it returns. A lookup that
// fails is the call's tool error and is tried again at the next call.
//
// The values are secrets of the server from the moment they are found: replaced with *** in every
// record the server's code logs (server.ts logs through `redactingLog`), in every tool result and in
// every error message. A short one (a user name) only where it stands whole, not inside a word of
// the data (the user name "Bund" leaves "Bundesländer" alone); one of LONG_SECRET_LENGTH characters
// or more (a token, a long password) wherever it stands. Where they came from is one INFO record of `<program>.config`, never the values.
// The server takes no credential from its argv: the environment (an MCP client's config sets it)
// or the repository's credentials file, or what api.ts obtains.

import type { Logger } from "@maschinenlesbar.org/dip-bundestag-log";
import * as api from "./api.js";
import type { Transport } from "./api.js";

/** What `findCredentials` gets to look with. */
export interface CredentialContext {
  /** The server's environment (index.ts: process.env; the tests: their own, never the real one). */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Whether the repository's credentials file may be read: true only from index.ts, so a test
   * (which never passes it) never reads a user's file.
   */
  credentialsFile: boolean;
  /** The server's transport (the limited one), for a request that obtains a credential. */
  transport: Transport;
  /** The server's limits for such a request. */
  timeoutMs: number;
  userAgent: string;
  maxResponseBytes: number;
}

/** What `findCredentials` found. */
export interface FoundCredentials {
  /** Options the client is built with, on top of the server's own (`{ apiKey }`). */
  clientOptions: Record<string, unknown>;
  /** The values never shown: every form a log record, result or error could carry. */
  secrets: readonly string[];
  /** Where they came from, for the INFO record ("the API key from FOO_API_KEY"); never a value. */
  source: string;
}

export type FindCredentials = (context: CredentialContext) => Promise<FoundCredentials>;

/**
 * api.ts's `findCredentials`, or undefined for an API without credentials. Read through the
 * module namespace, so an api.ts that exports none needs no change.
 */
export const findCredentials: FindCredentials | undefined = (api as unknown as { findCredentials?: FindCredentials }).findCredentials;

/** The shortest value treated as a secret: a shorter one would replace ordinary text. */
const MIN_SECRET_LENGTH = 4;

/**
 * The shortest secret replaced wherever it stands, even inside a longer run of letters and digits:
 * no word of the data is that long by chance. A shorter one is replaced only as a whole occurrence.
 */
export const LONG_SECRET_LENGTH = 16;

/**
 * Where `value` stands whole: not inside a run of letters and digits (any script), except after a
 * percent escape (`%3A` + the value, as in URL text, ends such a run).
 */
function wholeOccurrences(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:(?<![\\p{L}\\p{N}])|(?<=%[0-9A-Fa-f]{2}))${escaped}(?![\\p{L}\\p{N}])`, "gu");
}

/** The server's secrets, and how to take them out of a text or a result. */
export class Secrets {
  #values: string[] = [];
  /** Per value (in #values' order): how its occurrences are found, for a short one. */
  #whole = new Map<string, RegExp>();

  /** Make `values` secrets from now on (blank and very short ones are ignored). */
  add(values: readonly string[]): void {
    const all = new Set([...this.#values, ...values.filter((value) => value.trim().length >= MIN_SECRET_LENGTH)]);
    // Longest first: a secret that contains another is replaced whole.
    this.#values = [...all].sort((a, b) => b.length - a.length);
    for (const value of this.#values) if (value.length < LONG_SECRET_LENGTH && !this.#whole.has(value)) this.#whole.set(value, wholeOccurrences(value));
  }

  /** `text` with every secret replaced by `***` (a short one where it stands whole). */
  readonly redact = (text: string): string => {
    let out = text;
    for (const value of this.#values) {
      if (!out.includes(value)) continue;
      const whole = this.#whole.get(value);
      out = whole === undefined ? out.split(value).join("***") : out.replace(whole, "***");
    }
    return out;
  };

  /** `value` with every string in it (keys too) redacted; the same value when there are no secrets. */
  redactAll<T>(value: T): T {
    if (this.#values.length === 0) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") return this.redact(node);
      if (Array.isArray(node)) return node.map(walk);
      if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [this.redact(key), walk(item)]));
      return node;
    };
    return walk(value) as T;
  }
}

/** `log`, with the secrets replaced in every message it writes from now on. */
export function redactingLog(log: Logger, secrets: Secrets): Logger {
  return {
    get format() {
      return log.format;
    },
    set format(format) {
      log.format = format;
    },
    error: (area, msg) => log.error(area, secrets.redact(msg)),
    warn: (area, msg) => log.warn(area, secrets.redact(msg)),
    info: (area, msg) => log.info(area, secrets.redact(msg)),
  };
}
