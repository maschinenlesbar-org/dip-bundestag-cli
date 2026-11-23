// One limiter per server process, shared by every tool call and every HTTP client, around the
// client's transport: the API is someone else's production service, and one tool call can mean
// several requests (paging, a name resolved before the answer's own requests).
//  - at most `inFlight` requests at once (default 2);
//  - at most `perMinute` request starts in any 60 s (default 120);
//  - a 429 pauses every start for its Retry-After (or 5 s), on top of the engine's own retry,
//    for at most 30 s (the engine's own Retry-After ceiling): one answer can't stall the process;
//  - `pausedFor()` says how long that pause still holds every start (server.ts names it in the
//    record of a retry, which the limiter holds that long whatever the engine's own backoff);
//  - a clock set back (a wall-clock correction) stretches no hold past its longest (the pause's
//    30 s, the window's 60 s), and no timer gets more than setTimeout can take;
//  - at most `queue` requests wait (default 32); one more is refused at once (the client's
//    network error, so the call's answer says so);
//  - a waiting request whose signal aborts leaves the queue;
//  - a request made inside a tool call (callSignal.run) carries the call's signal too, so the
//    call's deadline and cancellation reach the transport even through a client whose calls
//    take no signal of their own; once that signal has aborted, nothing more is sent.

import { AsyncLocalStorage } from "node:async_hooks";
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from "./api.js";

export interface LimiterOptions {
  inFlight?: number;
  perMinute?: number;
  queue?: number;
  /** The clock (ms); tests inject one. */
  now?: () => number;
}

/** The signal of the tool call a request belongs to (server.ts runs every call inside it). */
export const callSignal = new AsyncLocalStorage<AbortSignal>();

const WINDOW_MS = 60_000;
const DEFAULT_PAUSE_MS = 5_000;
/** The longest pause a 429 starts: the engine retries no Retry-After over 30 s either. */
export const MAX_PAUSE_MS = 30_000;
/** The longest timer Node keeps: a longer one fires after 1 ms, with a warning. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Waiter {
  start: () => void;
  fail: (err: Error) => void;
}

/** The limited transport, and how long a 429's pause still holds every start (ms; 0 for none). */
export type LimitedTransport = Transport & { pausedFor(): number };

export function limitTransport(transport: Transport, options: LimiterOptions = {}): LimitedTransport {
  const inFlight = options.inFlight ?? 2;
  const perMinute = options.perMinute ?? 120;
  const queueSize = options.queue ?? 32;
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  const waiting: Waiter[] = [];
  let active = 0;
  let pausedUntil = 0;
  let timer: NodeJS.Timeout | undefined;

  /** Start as many waiters as the limits allow; else wake up when the next one may start. */
  const pump = (): void => {
    while (waiting.length > 0) {
      const t = now();
      // After the clock was set back, a hold counts from now, never longer than its longest.
      pausedUntil = Math.min(pausedUntil, t + MAX_PAUSE_MS);
      for (let i = starts.length - 1; i >= 0 && (starts[i] as number) > t; i--) starts[i] = t;
      while (starts.length > 0 && (starts[0] as number) <= t - WINDOW_MS) starts.shift();
      if (active >= inFlight) return;
      const wait = Math.max(pausedUntil - t, starts.length >= perMinute ? (starts[0] as number) + WINDOW_MS - t : 0);
      if (wait > 0) {
        if (timer === undefined) {
          timer = setTimeout(() => {
            timer = undefined;
            pump();
          }, Math.min(wait, MAX_TIMER_MS));
          timer.unref();
        }
        return;
      }
      const next = waiting.shift() as Waiter;
      active += 1;
      starts.push(t);
      next.start();
    }
  };

  const limited = async (sent: HttpRequest): Promise<HttpResponse> => {
    const call = callSignal.getStore();
    if (call?.aborted === true) throw new NetworkError(`${sent.method} ${sent.url} failed: aborted`);
    const request: HttpRequest =
      call === undefined ? sent : { ...sent, signal: sent.signal === undefined ? call : AbortSignal.any([sent.signal, call]) };
    if (waiting.length >= queueSize) {
      throw new NetworkError(`The server is busy: ${queueSize} requests to the API are already waiting. Try again shortly.`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { start: resolve, fail: reject };
      const signal = request.signal;
      if (signal !== undefined) {
        const leave = (): void => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) {
            waiting.splice(at, 1);
            reject(signal.reason instanceof Error ? signal.reason : new NetworkError("aborted"));
          }
        };
        if (signal.aborted) return leave();
        signal.addEventListener("abort", leave, { once: true });
        waiter.start = () => {
          signal.removeEventListener("abort", leave);
          resolve();
        };
      }
      waiting.push(waiter);
      pump();
    });
    try {
      const response = await transport(request);
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response.headers["retry-after"], now());
        pausedUntil = Math.max(pausedUntil, now() + Math.min(retryAfter ?? DEFAULT_PAUSE_MS, MAX_PAUSE_MS));
      }
      return response;
    } finally {
      active -= 1;
      pump();
    }
  };
  return Object.assign(limited, { pausedFor: () => Math.max(0, Math.min(pausedUntil - now(), MAX_PAUSE_MS)) });
}

/** A Retry-After header in ms from `now`: delta-seconds or an HTTP date; undefined for anything else. */
function retryAfterMs(header: string | string[] | undefined, now: number): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}
