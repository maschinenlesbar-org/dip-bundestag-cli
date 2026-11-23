// A bearer token for the HTTP transport (`--auth-token-file <path>`): every POST /mcp must then
// send `Authorization: Bearer <token>`, or it is answered 401 with `WWW-Authenticate: Bearer` and
// no detail. Any server can be started with one; a server whose API is called with a personal
// account (api.ts exports `HTTP_NEEDS_AUTH_TOKEN = true`) refuses to serve HTTP without one, so the
// account never becomes an open endpoint. stdio needs none: only the process that started the
// server talks to it.
//
// The file is read once, at start, with the rules of the CLI's credentials file (what ssh checks of
// a private key): a regular file, not a link, owned by the user the server runs as, readable by
// nobody else; one token of at least 32 characters a header can carry (RFC 6750's b64token), a
// trailing line break allowed. The token is compared in constant time, and it is never logged.
// The same in every repository (the kit).

import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import * as api from "./api.js";

/** True when this server's API is called with a personal account: HTTP only with a token. */
export const AUTH_TOKEN_REQUIRED: boolean = (api as unknown as { HTTP_NEEDS_AUTH_TOKEN?: boolean }).HTTP_NEEDS_AUTH_TOKEN === true;

/** The shortest token accepted: 32 characters (`openssl rand -hex 32` makes 64). */
export const MIN_TOKEN_LENGTH = 32;

/** A token file is small: more than this is not one. */
const MAX_TOKEN_FILE_BYTES = 4096;

/** RFC 6750's b64token: what an Authorization header carries without quoting. */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** How to make a good token file, for the messages. */
const MAKE_ONE = "Make one with: (umask 077; openssl rand -hex 32 > mcp-token)";

/** What `readAuthTokenFile` checks against (the tests pass another owner). */
export interface TokenFileOptions {
  /** The user the file must belong to (default: this process's). */
  uid?: number | undefined;
}

/**
 * The token in the file at `path`, or an Error whose message says what is wrong and how to fix it,
 * never the file's content.
 */
export function readAuthTokenFile(path: string, options: TokenFileOptions = {}): string {
  const fail = (why: string): Error => new Error(`--auth-token-file ${path}: ${why}`);
  let link;
  try {
    link = lstatSync(path);
  } catch (err) {
    throw fail(`can't be read (${(err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))}). ${MAKE_ONE}`);
  }
  if (link.isSymbolicLink()) throw fail("is a symbolic link; give the file itself.");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw fail(`can't be read (${(err as { code?: string }).code ?? String(err)}).`);
  }
  try {
    // Checked on the open descriptor: the file read is the file checked.
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw fail("is not a regular file.");
    if (process.platform !== "win32") {
      const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
      if (uid !== undefined && stats.uid !== uid) throw fail("belongs to another user; the server reads only its own user's token file.");
      if ((stats.mode & 0o077) !== 0) {
        throw fail(`can be read by others (mode ${(stats.mode & 0o777).toString(8)}); it is not used until only you can: chmod 600 ${path}`);
      }
    }
    if (stats.size > MAX_TOKEN_FILE_BYTES) throw fail(`is ${stats.size} bytes; a token file holds one token.`);
    const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length; length += read) read = readSync(fd, buffer, length, buffer.length - length, null);
    const token = buffer.subarray(0, length).toString("utf8").replace(/\r?\n$/, "");
    if (token.length < MIN_TOKEN_LENGTH) throw fail(`holds no token of at least ${MIN_TOKEN_LENGTH} characters. ${MAKE_ONE}`);
    if (!B64TOKEN.test(token)) throw fail(`holds more than one token of letters, digits and -._~+/ (a space, a second line or another character). ${MAKE_ONE}`);
    return token;
  } finally {
    closeSync(fd);
  }
}

/**
 * True when the Authorization header is `Bearer <token>` (the scheme in any case). The two are
 * compared as SHA-256 digests with timingSafeEqual: in constant time, whatever their lengths.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const found = /^Bearer +(\S+) *$/i.exec(header ?? "");
  const sent = found?.[1] ?? "";
  const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();
  return timingSafeEqual(digest(sent), digest(token)) && found !== null;
}
