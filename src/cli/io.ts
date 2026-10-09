// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { statSync, writeFileSync } from "node:fs";
import { DipError, DipUsageError } from "../client/errors.js";
import type { DipClient, DipClientOptions } from "../client/client.js";
import type { Transport } from "../client/http.js";
import type { CredentialStore } from "./credentials.js";
import { createLogger, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. Refuses to overwrite an existing file unless
   * `force` is set, so a mistyped `-o` cannot silently clobber the user's data.
   */
  writeFile(path: string, data: Buffer, force?: boolean): void;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
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
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1. On stderr an EPIPE (or ENOTCONN) is ignored, so a failed run keeps its exit code; any other
 * stderr error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const defaultIO: CliIO = {
  readSecret: (prompt) => readSecretFrom(process.stdin, process.stderr, prompt),
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  // "wx" fails if the path already exists (a dangling symlink included, since an
  // exclusive create never follows one), turning an accidental overwrite into a
  // clean error instead of silent data loss. With --force we fall back to the
  // default truncating write.
  writeFile: (path, data, force) => {
    try {
      writeFileSync(path, data, { flag: force ? "w" : "wx" });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      // `wx` answers EEXIST and `w` EISDIR for a directory; --force cannot help there.
      if ((code === "EEXIST" || code === "EISDIR") && isDirectory(path)) {
        throw new DipError(`"${path}" is a directory; give a file path to --output.`, { cause });
      }
      if (code === "EEXIST") {
        throw new DipError(
          `Refusing to overwrite existing file "${path}"; pass --force to overwrite.`,
          { cause },
        );
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
