// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DipError, DipUsageError } from "@maschinenlesbar.org/dip-bundestag-client/internal/errors";
import type { DipClient, DipClientOptions } from "@maschinenlesbar.org/dip-bundestag-client/internal/client";
import type { Transport } from "@maschinenlesbar.org/dip-bundestag-client/internal/http";
import type { CredentialStore } from "./credentials.js";
import { createLogger, type Logger } from "./log.js";

/**
 * Writing the output to the `-o` file failed (an existing file without `--force`, a
 * directory, EACCES, …). Logged as an ERROR of `dip.output`, exit 1.
 */
export class OutputError extends DipError {}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. Refuses to overwrite an existing file unless
   * `force` is set, so a mistyped `-o` cannot silently clobber the user's data.
   */
  writeFile(path: string, data: Buffer, force?: boolean): void;
  /**
   * What is at an `-o` path, for the check before any request (`checkOutputTarget`):
   * nothing, a directory, or anything else (a file, a link, a dangling one too). Unset, the
   * real file system (`outputPathState`).
   */
  outputState?(path: string): OutputPathState;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
  /**
   * stdout without the run's redaction, for the one value the user asked for in full:
   * `dip config get --reveal`. Set by `run()` (`withRedactedOutput`); unset, `out` is used.
   */
  outRaw?(text: string): void;
  /**
   * Read a secret for `dip config set`: typed at a prompt without echo, or piped in.
   * Optional: without it, `config set` refuses rather than reading the command line.
   */
  readSecret?(prompt: string): Promise<string>;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: DipClientOptions): DipClient;
  /**
   * Environment lookup, injected so the env-driven config (DIP_API_KEY) is
   * testable without mutating process.env. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
  /**
   * Transport for requests made *outside* the API client — currently only
   * `obtain-key`, which runs before a key (and therefore a client) exists.
   * Defaults to the built-in node:http/https transport.
   */
  transport?: Transport;
  /**
   * The credentials file (`dip config`), consulted for the API key when neither
   * `--api-key` nor `DIP_API_KEY` gives one. Optional: deps without it — every test
   * that does not ask for it — never read a credentials file, the user's least of all.
   */
  credentials?: () => CredentialStore;
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
  /**
   * Set by `action()` when the API key came from the credentials file: the file's path,
   * so the 401 hint can name it. `run()` gives every run deps of its own, so it never
   * outlives the run.
   */
  storedKeyPath?: string;
  /**
   * Make a value a secret of the run, replaced in every record from now on. Set by
   * `run()`; the credentials file's values go through it the moment they are read, so a
   * stored key is kept out of the log like one from `--api-key` or `DIP_API_KEY`.
   */
  addSecret?(value: string): void;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
}

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error is an ERROR record of `dip.output` (`Could not write to stdout:
 * <message>`, through `log`, in the run's format) and exits 1. On stderr an EPIPE (or
 * ENOTCONN) is ignored, so a failed run keeps its exit code; any other stderr error
 * exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`, with a logger for the format argv
 * asks for (`processLogger`).
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
  log: Pick<Logger, "error"> = createLogger({ format: "text", write: (line) => process.stderr.write(line + "\n") }),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    log.error("output", `Could not write to stdout: ${err.message}`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` used to turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

/** What is at an `-o` path. */
export type OutputPathState = "absent" | "directory" | "exists";

/** What is at `path` on the real file system: a dangling link counts as "exists". */
export function outputPathState(path: string): OutputPathState {
  try {
    return statSync(path).isDirectory() ? "directory" : "exists";
  } catch {
    // statSync follows a link; a dangling one is still a name the exclusive create
    // refuses, so lstat decides between "exists" and "absent".
    try {
      lstatSync(path);
      return "exists";
    } catch {
      return "absent";
    }
  }
}

/** The message for an existing `-o` path without `--force`. */
export function refuseOverwrite(path: string): string {
  return `Refusing to overwrite existing file "${path}"; pass --force to overwrite.`;
}

/** The message for an `-o` path that is a directory, which `--force` can't fix. */
export function isDirectoryMessage(path: string): string {
  return `"${path}" is a directory; give a file path to --output.`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Replace `target` with `data` atomically: a temporary file beside it, created
 * exclusively, renamed over it. A write cut short (a full disk, a quota, a killed
 * process) leaves the old file as it was, never half of the new one. An existing
 * file's mode is kept, as the in-place write kept it.
 */
function replaceFile(target: string, data: Buffer): void {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, data, { flag: "wx" });
    const mode = existingMode(target);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * The file a path names, through any symlinks, so `--force` replaces the file a link
 * points at (as the in-place write did) rather than the link. A dangling link is
 * replaced itself.
 */
function throughLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** What `stderrAfterStdout` needs of stdout: its backlog, and the events that end one. */
export interface StdoutBacklog {
  readonly writableLength: number;
  on(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** How often a held record checks whether stdout's backlog is gone (ms). */
const BACKLOG_POLL_MS = 10;

/**
 * A stderr writer that waits for stdout. With both streams on one pipe (`2>&1 |`) and a
 * slow reader, stdout's data is still queued in the process while a record is written
 * to stderr at once, so the record landed inside the JSON (at 64 KiB). Here a text is
 * held while `stdout.writableLength > 0` and written, in order, once the backlog is
 * gone: on stdout's `drain`, `close` or `error`, or at the latest when a short poll sees
 * it empty (`drain` only follows a write that returned false). The poll keeps the
 * process alive until then, so a held record is never lost at exit.
 */
export function stderrAfterStdout(stdout: StdoutBacklog, write: (text: string) => void): (text: string) => void {
  const held: string[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const flush = (): void => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    for (const text of held.splice(0)) write(text);
  };
  let listening = false;
  return (text) => {
    if (held.length === 0 && stdout.writableLength === 0) return write(text);
    held.push(text);
    if (!listening) {
      listening = true;
      for (const event of ["drain", "close", "error"] as const) stdout.on(event, flush);
    }
    poll ??= setInterval(() => {
      if (stdout.writableLength === 0) flush();
    }, BACKLOG_POLL_MS);
  };
}

const stderrLine = stderrAfterStdout(process.stdout, (text) => process.stderr.write(text + "\n"));

/** A short pause for a non-blocking descriptor that is full (EAGAIN), without a busy loop. */
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write all of `data` to `fd`, or throw. `writeSync` may write less than asked (a file-size
 * limit, a full disk): the rest is written in a loop, and the call that cannot write throws
 * (EFBIG, ENOSPC). A descriptor the shell made non-blocking (a pipe through `/dev/fd/N`) answers
 * EAGAIN while the reader is behind: wait a moment and go on.
 */
function writeAll(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    try {
      at += writeSync(fd, data, at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

/** What `stdoutWriter` needs of stdout. */
interface Stdout {
  write(text: string): unknown;
  emit(event: "error", err: Error): unknown;
  readonly fd?: number;
}

/**
 * A writer for stdout that never drops a byte silently. When stdout is a regular file
 * (`> out.json`), Node's stream wrote it with one `writeSync` and ignored a short count, so a
 * file-size limit or a full disk cut the output short with exit 0 and nothing on stderr. Here
 * the text is written with `writeAll`, and a failure (EFBIG, ENOSPC) is emitted as stdout's
 * `error`, which `handleOutputErrors` turns into an ERROR record of `dip.output` and exit 1.
 * A pipe, a socket or a terminal goes through the stream as before (EPIPE stays quiet).
 */
export function stdoutWriter(stdout: Stdout = process.stdout, write: (fd: number, data: Buffer) => void = writeAll): (text: string) => void {
  let toFile: boolean | undefined;
  return (text) => {
    toFile ??= stdout.fd !== undefined && isRegularFile(stdout.fd);
    if (!toFile) {
      stdout.write(text);
      return;
    }
    try {
      write(stdout.fd as number, Buffer.from(text, "utf8"));
    } catch (err) {
      stdout.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  };
}

function isRegularFile(fd: number): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const stdoutText = stdoutWriter();

export const defaultIO: CliIO = {
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
  out: (text) => stdoutText(text + "\n"),
  // A record never lands inside the data when both streams share a pipe.
  err: stderrLine,
  writeFile: (path, data, force) => {
    if (isDirectory(path)) throw new DipError(isDirectoryMessage(path));
    let claimed = false;
    try {
      // Without --force the name is claimed first with an exclusive create, which fails if
      // the path exists (a dangling symlink included, since it never follows one): an
      // accidental overwrite is a clean error instead of silent data loss.
      if (!force) {
        closeSync(openSync(path, "wx"));
        claimed = true;
      }
      replaceFile(force ? throughLinks(path) : path, data);
    } catch (cause) {
      // A write cut short (a full disk) leaves no file under the new name either, so the
      // next run isn't refused for a file that holds half a result.
      if (claimed) rmSync(path, { force: true });
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST" && !claimed) {
        throw new DipError(refuseOverwrite(path), { cause });
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new DipError(`Could not write to "${path}": ${reason}`, { cause });
    }
  },
  outBinary: (data) => process.stdout.write(data),
};

/**
 * The longest secret `readSecretFrom` takes (64 KiB). Reading stops beyond it, so an
 * endless input (`< /dev/zero`) cannot grow memory without bound, and a value that
 * could never be sent as a header is not stored.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

/**
 * True when `rest`, what followed a line break `brk` in the same read, holds more than
 * the LF of a CR LF and escape sequences (a bracketed-paste end marker).
 */
function moreAfterLineBreak(rest: string, brk: string): boolean {
  const tail = brk === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
  // Built from char codes, so the source stays free of control bytes.
  const esc = String.fromCharCode(0x1b);
  const sequences = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]|${esc}O.|${esc}`, "g");
  return tail.replace(sequences, "") !== "";
}

/** The refusal of a secret longer than `MAX_SECRET_BYTES`. */
function secretTooLong(): DipUsageError {
  return new DipUsageError("The value is longer than 64 KiB; nothing was stored.");
}

/**
 * `CliIO.readSecret` over real streams. From a pipe or a file (`< key.txt`,
 * `dip obtain-key | dip config set api-key`) the whole input, one trailing newline
 * dropped. On a terminal the input is read in raw mode, so nothing is echoed: Enter
 * ends it, Backspace takes a character back, Ctrl-C stops (nothing stored) and Ctrl-D
 * ends it like Enter. Escape sequences (arrow keys, bracketed-paste markers) are dropped;
 * any other character, a tab included, is kept, so `config set` refuses what it would
 * refuse from a pipe; a paste with more after its first line break is refused. Either way a value longer than `MAX_SECRET_BYTES` is refused
 * (`DipUsageError`), and reading stops there.
 */
export async function readSecretFrom(
  stdin: NodeJS.ReadStream | NodeJS.ReadableStream,
  stderr: Pick<NodeJS.WriteStream, "write">,
  prompt: string,
): Promise<string> {
  const tty = stdin as NodeJS.ReadStream;
  if (tty.isTTY !== true || typeof tty.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      chunks.push(buffer);
      bytes += buffer.length;
      // Room for the line break that is dropped below; leaving the loop destroys the stream.
      if (bytes > MAX_SECRET_BYTES + 2) throw secretTooLong();
    }
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw secretTooLong();
    return value;
  }
  stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    // Where an escape sequence stands, across reads: after ESC, inside a CSI (`ESC [`
    // parameters… final, bracketed-paste markers included), before SS3's final (`ESC O x`).
    let escape: "none" | "esc" | "csi" | "ss3" = "none";
    const finish = (error?: Error): void => {
      tty.removeListener("data", onData);
      tty.setRawMode(false);
      tty.pause();
      stderr.write("\n");
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const chars = [...chunk.toString()];
      for (const [i, ch] of chars.entries()) {
        // An arrow key or a paste marker is a keystroke, not part of the value.
        if (escape === "csi") {
          if (ch >= "@" && ch <= "~") escape = "none";
          continue;
        }
        if (escape === "ss3") {
          escape = "none";
          continue;
        }
        if (escape === "esc") {
          escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none";
          if (escape !== "none") continue;
        }
        if (ch === "\u001b") {
          escape = "esc";
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          // A paste with more after its first line break: storing the first line alone
          // would keep a value the user did not mean, and leave the rest to the shell.
          if (moreAfterLineBreak(chars.slice(i + 1).join(""), ch)) {
            return finish(new DipUsageError("The value holds a line break; nothing was stored."));
          }
          return finish();
        }
        if (ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new DipError("Interrupted; nothing was stored."));
        if (ch === "\u007f" || ch === "\b") value = [...value].slice(0, -1).join("");
        // Any other character is kept, a tab or a control character included, so the
        // value is refused as the same input from a pipe is, not silently changed.
        else value += ch;
        if (value.length > MAX_SECRET_BYTES) return finish(secretTooLong());
      }
    };
    tty.setRawMode(true);
    tty.resume();
    tty.on("data", onData);
  });
}
