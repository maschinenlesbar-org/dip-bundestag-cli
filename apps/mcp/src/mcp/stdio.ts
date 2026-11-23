// stdio for the SDK's serveStdio (its `transport` option): newline-delimited JSON-RPC on stdin and
// stdout, as the SDK's StdioServerTransport reads and writes it, with one difference: the end of
// stdin doesn't close it. The SDK's closed at once and dropped the calls it had read but not yet
// answered (a client that writes its requests and closes the pipe got only the initialize back,
// exit 0, nothing in the log). run.ts waits for them (`whenAnswered`) and closes then.

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

  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
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
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(JSON.parse(line));
    } catch (error) {
      // As the SDK's transport: a line that isn't JSON is skipped, one that isn't JSON-RPC reported.
      if (!(error instanceof SyntaxError)) this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (isJSONRPCRequest(message)) this.pending.add(message.id);
    else if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      // A cancelled request gets no answer.
      const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      if (id !== undefined) this.settle(id);
    }
    this.onmessage?.(message);
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
