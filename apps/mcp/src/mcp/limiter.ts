// One limiter per server process, shared by every tool call and every HTTP client, around the
// client's transport: the API is someone else's production service, and one tool call can mean
// several requests (paging, a name resolved before the answer's own requests).
//  - at most `inFlight` requests at once (default 2);
//  - at most `perMinute` request starts in any 60 s (default 120);
//  - a 429 pauses every start to the origin that answered it for its Retry-After (or 5 s), on top
//    of the engine's own retry, for at most 30 s (the engine's own Retry-After ceiling): one answer
//    can't stall the process, and an API on several hosts (a list of portals) goes on with the
//    others; a request waiting for a paused origin holds up none to another;
//  - `pausedFor(url)` says how long that pause still holds the starts to the url's origin
//    (server.ts names it in the record of a retry, which the limiter holds that long whatever the
//    engine's own backoff);
//  - a clock set back (a wall-clock correction) stretches no hold past its longest (the pause's
//    30 s, the window's 60 s), and no timer gets more than setTimeout can take;
//  - at most `queue` requests wait (default 32); one more is refused at once (the client's
//    network error, so the call's answer says so);
//  - a waiting request whose signal aborts leaves the queue;
//  - a request the budget or a pause would hold longer than it may wait (its own timeoutMs, its
//    call's deadline) is refused at once with the client's network error, naming the limit and
//    when it frees: the wait counts against the request's deadline, which would otherwise fail
//    it with "exceeded deadline" for a request never sent. A hold is logged once (`log`);
//  - a request made inside a tool call (callScope.run) carries the call's signal too, so the
//    call's deadline and cancellation reach the transport even through a client whose calls
//    take no signal of their own; once that signal has aborted, nothing more is sent;
//  - a request made inside a tool call notes the call's redirects across origins (`Redirects`), so
//    an answer a client that follows redirects fetched from another origin is not cited as the
//    API's own (server.ts). For a client that follows none, a redirect is an error and this a no-op.

import { AsyncLocalStorage } from "node:async_hooks";
import { NetworkError, type HttpRequest, type HttpResponse, type Transport } from "./api.js";

export interface LimiterOptions {
  inFlight?: number;
  perMinute?: number;
  queue?: number;
  /** The clock (ms); tests inject one. */
  now?: () => number;
  /** A WARN record when requests start being held by the budget or a pause (run.ts: `http`). */
  log?: (message: string) => void;
}

/** The tool call a request belongs to: its signal, and when its deadline passes (`now`'s clock). */
export interface CallScope {
  signal: AbortSignal;
  endsAt?: number;
  /** Where the call's requests were redirected to (server.ts reads it after the call). */
  redirects?: Redirects;
}

/** The HTTP statuses a client follows as a redirect. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** `url`'s origin (resolved against `base`), or undefined when it doesn't parse. */
function originOf(url: string, base?: string): string | undefined {
  try {
    return new URL(url, base).origin;
  } catch {
    return undefined;
  }
}

/**
 * A tool call's redirects across origins, as the limited transport sees each hop: which origins
 * answered (with anything but a redirect) a request that a redirect from another origin led to.
 */
export class Redirects {
  /** An origin a redirect points to, and the origin its chain of redirects started at. */
  #pending = new Map<string, string>();
  /** The origins that answered after a redirect, each with the origin the chain started at. */
  readonly answered = new Map<string, string>();

  /** Take note of the answer to a request for `url`. */
  note(url: string, response: HttpResponse): void {
    const origin = originOf(url);
    if (origin === undefined) return;
    const start = this.#pending.get(origin) ?? origin;
    const location = response.headers.location;
    if (REDIRECTS.has(response.status) && typeof location === "string") {
      const target = originOf(location, url);
      if (target !== undefined && target !== start) this.#pending.set(target, start);
      return;
    }
    if (start !== origin) this.answered.set(origin, start);
  }
}

/** The tool call of the requests made inside it (server.ts runs every call inside it). */
export const callScope = new AsyncLocalStorage<CallScope>();

const WINDOW_MS = 60_000;
const DEFAULT_PAUSE_MS = 5_000;
/** The longest pause a 429 starts: the engine retries no Retry-After over 30 s either. */
export const MAX_PAUSE_MS = 30_000;
/** The longest timer Node keeps: a longer one fires after 1 ms, with a warning. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Waiter {
  /** The origin it is for (a 429's pause holds only its own). */
  origin: string;
  start: () => void;
  fail: (err: Error) => void;
}

/**
 * The limited transport, and how long a 429's pause still holds the starts to `url`'s origin (ms;
 * 0 for none); without a url, the longest pause of any origin.
 */
export type LimitedTransport = Transport & { pausedFor(url?: string): number };

export function limitTransport(transport: Transport, options: LimiterOptions = {}): LimitedTransport {
  const inFlight = options.inFlight ?? 2;
  const perMinute = options.perMinute ?? 120;
  const queueSize = options.queue ?? 32;
  const now = options.now ?? Date.now;
  const starts: number[] = [];
  const waiting: Waiter[] = [];
  let active = 0;
  /** Until when a 429 pauses the starts to an origin. */
  const pausedUntil = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  /** Until when a hold is logged already: per origin for a pause, "" for the budget. */
  const loggedUntil = new Map<string, number>();

  /** Forget the starts that left the window and the pauses that ended; after the clock was set back, count holds from now. */
  const prune = (t: number): void => {
    for (const [origin, until] of pausedUntil) {
      if (until <= t) pausedUntil.delete(origin);
      else pausedUntil.set(origin, Math.min(until, t + MAX_PAUSE_MS));
    }
    for (let i = starts.length - 1; i >= 0 && (starts[i] as number) > t; i--) starts[i] = t;
    while (starts.length > 0 && (starts[0] as number) <= t - WINDOW_MS) starts.shift();
  };

  /** How long a 429's pause still holds the starts to `origin`. */
  const pauseOf = (origin: string, t: number): number => Math.max(0, (pausedUntil.get(origin) ?? 0) - t);

  /** How long the budget holds a start with `ahead` requests waiting before it (at least, when unknown). */
  const budgetWait = (t: number, ahead: number): number => {
    const index = starts.length + ahead - perMinute;
    if (index < 0) return 0;
    return index < starts.length ? (starts[index] as number) + WINDOW_MS - t : WINDOW_MS;
  };

  /** Start as many waiters as the limits allow, the first whose origin no pause holds; else wake up when the next one may start. */
  const pump = (): void => {
    while (waiting.length > 0) {
      const t = now();
      prune(t);
      if (active >= inFlight) return;
      const at = waiting.findIndex((waiter) => pauseOf(waiter.origin, t) === 0);
      const wait = Math.max(budgetWait(t, 0), at >= 0 ? 0 : Math.min(...waiting.map((waiter) => pauseOf(waiter.origin, t))));
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
      const next = waiting.splice(at, 1)[0] as Waiter;
      active += 1;
      starts.push(t);
      next.start();
    }
  };

  const limited = async (sent: HttpRequest): Promise<HttpResponse> => {
    const scope = callScope.getStore();
    const call = scope?.signal;
    if (call?.aborted === true) throw new NetworkError(`${sent.method} ${sent.url} failed: aborted`);
    const request: HttpRequest =
      call === undefined ? sent : { ...sent, signal: sent.signal === undefined ? call : AbortSignal.any([sent.signal, call]) };
    if (waiting.length >= queueSize) {
      throw new NetworkError(`The server is busy: ${queueSize} requests to the API are already waiting. Try again shortly.`);
    }
    const origin = originOf(request.url) ?? "";
    const t = now();
    prune(t);
    const paused = pauseOf(origin, t);
    const budget = budgetWait(t, waiting.length);
    const held = Math.max(paused, budget);
    if (held > 0) {
      const seconds = Math.ceil(held / 1000);
      const by429 = paused >= budget;
      const who = origin === "" ? "the API" : origin;
      const why = by429
        ? `${who} answered HTTP 429 (too many requests), and this server holds every request to it for ${seconds} s more`
        : `this server sends at most ${perMinute} requests a minute to the API and has used them up; the next can start in ${seconds} s`;
      const key = by429 ? origin : "";
      if (t >= (loggedUntil.get(key) ?? 0)) {
        loggedUntil.set(key, t + held);
        options.log?.(by429 ? `${who} answered HTTP 429: every request to it waits ${seconds} s` : `the budget of ${perMinute} requests a minute to the API is used up: requests wait up to ${seconds} s`);
      }
      const timeout = request.timeoutMs !== undefined && request.timeoutMs > 0 ? request.timeoutMs : Infinity;
      const mayWait = Math.min(timeout, scope?.endsAt === undefined ? Infinity : scope.endsAt - t);
      if (held > mayWait) throw new NetworkError(`not sent: ${why}, longer than this ${mayWait === timeout ? "request" : "call"} may wait. Ask again in ${seconds} s.`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { origin, start: resolve, fail: reject };
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
      scope?.redirects?.note(request.url, response);
      if (response.status === 429) {
        const retryAfter = retryAfterMs(response.headers["retry-after"], now());
        pausedUntil.set(origin, Math.max(pausedUntil.get(origin) ?? 0, now() + Math.min(retryAfter ?? DEFAULT_PAUSE_MS, MAX_PAUSE_MS)));
      }
      return response;
    } finally {
      active -= 1;
      pump();
    }
  };
  const pausedFor = (url?: string): number => {
    const t = now();
    // A url that doesn't parse (a record's cut one) gets the longest pause, as no url does.
    const origin = url === undefined ? undefined : originOf(url);
    const until = origin === undefined ? Math.max(0, ...pausedUntil.values()) : (pausedUntil.get(origin) ?? 0);
    return Math.max(0, Math.min(until - t, MAX_PAUSE_MS));
  };
  return Object.assign(limited, { pausedFor });
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
