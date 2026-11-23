// stdio for the SDK's serveStdio (its `transport` option): newline-delimited JSON-RPC on stdin and
// stdout, as the SDK's StdioServerTransport reads and writes it, with two differences:
//  - the end of stdin doesn't close it. The SDK's closed at once and dropped the calls it had read
//    but not yet answered (a client that writes its requests and closes the pipe got only the
//    initialize back, exit 0, nothing in the log). run.ts waits for them (`whenAnswered`).
//  - a line that isn't JSON is answered with a parse error (-32700), one that isn't a JSON-RPC 2.0
//    message with an invalid request (-32600), both with id null as JSON-RPC 2.0 says, and leaves
//    a WARN record. The SDK's skipped them in silence: a client with a framing bug waited forever.

import type { Readable, Writable } from "node:stream";
import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  parseJSONRPCMessage,
  serializeMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";

export class StdioWire implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private buffer: Buffer | undefined;
  /** The requests read and not yet answered (nor cancelled). */
  private readonly pending = new Set<RequestId>();
  private waiters: ((left: number) => void)[] = [];
  private closed = false;

  /** `warn`: one WARN record (run.ts: of `<program>.mcp`). */
  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
    private readonly warn: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onStdinError);
  }

  /** How many requests were read and are not answered yet. */
  unanswered(): number {
    return this.pending.size;
  }

  /** Resolves with 0 once every request read is answered, or with how many are not after `timeoutMs`. */
  whenAnswered(timeoutMs: number): Promise<number> {
    if (this.pending.size === 0) return Promise.resolve(0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve(this.pending.size);
      }, timeoutMs);
      const done = (left: number): void => {
        clearTimeout(timer);
        resolve(left);
      };
      this.waiters.push(done);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("stdio is closed"));
    // A response (no method) answers the request of its id once it is written out.
    const answered = !("method" in message) && "id" in message ? message.id : undefined;
    return new Promise((resolve, reject) => {
      this.stdout.write(serializeMessage(message), (error) => {
        if (answered !== undefined) this.settle(answered);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onStdinError);
    this.buffer = undefined;
    this.release();
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer): void => {
    if ((this.buffer?.length ?? 0) + chunk.length > STDIO_DEFAULT_MAX_BUFFER_SIZE) {
      this.buffer = undefined;
      this.onerror?.(new Error(`A message on stdin is longer than ${STDIO_DEFAULT_MAX_BUFFER_SIZE} bytes.`));
      void this.close();
      return;
    }
    this.buffer = this.buffer === undefined ? chunk : Buffer.concat([this.buffer, chunk]);
    for (let end = this.buffer.indexOf(10); end >= 0; end = this.buffer?.indexOf(10) ?? -1) {
      const line = this.buffer.toString("utf8", 0, end).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(end + 1);
      this.receive(line);
    }
  };

  private readonly onStdinError = (error: Error): void => this.onerror?.(error);

  private receive(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.refuse(-32700, "Parse error: the line is not JSON.");
    }
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(value);
    } catch {
      return this.refuse(-32600, "Invalid Request: the line is not a JSON-RPC 2.0 message (one object per line, jsonrpc \"2.0\", a method or a result).");
    }
    if (isJSONRPCRequest(message)) this.pending.add(message.id);
    else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      // A cancelled request gets no answer.
      const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      if (id !== undefined) this.settle(id);
    }
    this.onmessage?.(message);
  }

  /** Answer a line that can't be served, with id null (its id can't be trusted), and log it. */
  private refuse(code: number, message: string): void {
    this.warn(`stdin: ${message} Answered with JSON-RPC error ${code}.`);
    if (!this.closed) this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } })}\n`);
  }

  private settle(id: RequestId): void {
    this.pending.delete(id);
    if (this.pending.size === 0) this.release();
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(this.pending.size);
  }
}
