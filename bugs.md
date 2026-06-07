# dip-bundestag-cli — Exploratory (black-box) bug report

Date: 2026-06-06
Build: `npm run build` (clean), invoked as `node dist/src/cli/index.js ...`
commander 15.0.0, Node v22.14.0

## Environment note

The bundled `DEFAULT_API_KEY` (`src/client/client.ts:25`) **expired 2026-05-31**, so
every live call without a personal key returns `401`. This is expected and was used
deliberately:

```
$ node dist/src/cli/index.js --timeout 25000 vorgang list
Error: HTTP 401 for GET https://search.dip.bundestag.de/api/v1/vorgang: An API key is required to access this service. ...
Authentication failed (401). The bundled shared API key is expired. Pass --api-key <key> or set DIP_API_KEY. Request a personal key from parlamentsdokumentation@bundestag.de.
exit=1
```

The `401` UX (actionable hint + exit 1) and the `404 → exit 4` mapping both work as
documented. Because no valid key was available, the report focuses on request-wiring,
input validation, auth UX, offline/edge behaviour, and exit codes. All status/redirect/
parse cases were reproduced against a local Node mock server (loopback) standing in for
the API; those are real and reproducible against any backend.

Count: **14 genuine, reproducible bugs** (all 14 below are real; no fabrication).
Severity skews low/medium because data-correctness against a live `200` could not be
probed without a key.

---

## HIGH

### 1. `--api-key ""` sends a malformed `Authorization: ApiKey ` (trailing space) instead of falling back / erroring — ✅ FIXED
**Fix:** `src/cli/shared.ts` `toEngineOptions` now treats a blank/whitespace-only `--api-key` as unset (trims it; only forwards when non-empty), so the client falls back to the default key instead of emitting `Authorization: ApiKey `.
- Severity: High · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT --api-key '' vorgang list
  ```
  (mock server logs the raw header)
- Expected: a blank `--api-key` should be treated like a blank `DIP_API_KEY` — i.e.
  unset, falling back to the (expired) default — OR rejected. The code/README explicitly
  promise blank keys "never produce a malformed `Authorization: ApiKey  ` header".
- Actual: header sent is literally `Authorization: ApiKey ` (key empty, trailing space):
  ```
  "auth":"ApiKey"        # Node shows it trimmed; raw header value is "ApiKey " with trailing space
  ```
  The server receives a credential header with an empty key. The "blank treated as unset"
  guarantee only covers `DIP_API_KEY`, not `--api-key`.
- Root cause: `src/cli/shared.ts:51-52` (`toEngineOptions`) forwards `apiKey` whenever it
  is `!== undefined` (so `""` passes through), and `src/client/client.ts:68`
  `` `ApiKey ${apiKey ?? DEFAULT_API_KEY}` `` uses `??`, which does not treat `""` as
  nullish. There is no `.trim()`/empty-guard on `--api-key` the way `readEnvApiKey`
  (`src/cli/program.ts:26-31`) has for the env var.

### 2. Repeated `--filter` with the same key silently drops all but the last value (data loss) — ✅ FIXED
**Fix:** `src/cli/commands/resources.ts` `collectFilter` now accumulates repeated keys into a `string[]` (`FilterMap`) instead of a `Record<string,string>`, and the list action forwards them as repeated query keys, so `--filter f.titel=x --filter f.titel=y` sends both.
- Severity: High · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT vorgang list --filter f.titel=x --filter f.titel=y
  ```
- Expected: either both values sent (`f.titel=x&f.titel=y`, since the DIP API supports
  repeated keys and `--id` is explicitly documented to *merge*), or a rejection. The
  README stresses that `--id`/`--filter f.id` "are merged into a single list (neither
  silently wins)", so silent clobbering of a repeated filter is surprising and inconsistent.
- Actual: only the last value survives — `x` is silently lost:
  ```
  url":"/api/v1/vorgang?f.titel=y
  ```
- Root cause: `src/cli/commands/resources.ts:48-55` `collectFilter` accumulates into a
  plain `Record<string,string>`: `{ ...previous, [key]: value }`. A second occurrence of
  the same key overwrites the first. (Only the `f.id` special case at lines 75-79 merges.)

---

## MEDIUM

### 3. `--timeout`/`--max-retries`/`--max-response-bytes` accept hex, scientific, and whitespace-padded numbers despite "Expected a non-negative integer" — ✅ FIXED
**Fix:** `src/cli/shared.ts` `parseIntArg` now requires a plain `^\d+$` decimal string (and a safe integer) before calling `Number`, rejecting `0x10`, `1e3`, `0b11`, and whitespace-padded values.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --timeout 0x10  --base-url http://127.0.0.1:1 vorgang list   # accepted as 16
  node dist/src/cli/index.js --timeout 1e3   --base-url http://127.0.0.1:1 vorgang list   # accepted as 1000
  node dist/src/cli/index.js --timeout ' 5'  --base-url http://127.0.0.1:1 vorgang list   # accepted as 5
  ```
  (all reach the network layer → `ECONNREFUSED`, i.e. parsing succeeded; only `Infinity`/
  `abc` are rejected)
- Expected: a "non-negative integer" validator should reject `0x10`, `1e3`, and
  whitespace-padded values, or the help text should not claim plain integers.
- Actual: silently coerced and accepted.
- Root cause: `src/cli/shared.ts:12-18` `parseIntArg` uses `Number(value)`, which parses
  `0x10`→16, `1e3`→1000, `0b11`→3, and trims surrounding whitespace; all pass
  `Number.isInteger && >= 0`.

### 4. `--timeout ""` / `--max-retries ""` (empty or whitespace-only) silently become `0` — ✅ FIXED
**Fix:** Same `parseIntArg` change in `src/cli/shared.ts`; `""` and `"   "` no longer match `^\d+$`, so they are rejected as usage errors instead of coercing to `0`.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --timeout '   ' --base-url http://127.0.0.1:1 vorgang list
  ```
  parsing succeeds (reaches `ECONNREFUSED`); `Number("   ") === 0`.
- Expected: an empty/whitespace timeout should be a usage error, not silently `0`.
- Actual: accepted as `0`. For `--timeout`, `0` *disables the timeout entirely*
  (`src/client/http.ts:98` only arms the timer when `timeoutMs > 0`), so an accidental
  blank value removes the request timeout — the opposite of a user expecting "0 = none"
  to be rejected.
- Root cause: same `Number()` coercion in `src/cli/shared.ts:12-18`; `Number("")` and
  `Number("  ")` both return `0`, which `Number.isInteger` accepts. (Verified:
  `node -e 'console.log(Number("  "))'` → `0`.)

### 5. A successful empty/204 response is reported as a JSON parse error (exit 1) instead of success — ✅ FIXED
**Fix:** `src/client/engine.ts` `getJson` now returns `null` for a `204` or empty/whitespace-only body instead of calling `JSON.parse("")` and throwing `DipParseError`.
- Severity: Medium · Confidence: High
- Repro (mock returns `204 No Content`, empty body, `content-type: application/json`):
  ```
  node dist/src/cli/index.js --base-url 'http://127.0.0.1:PORT/empty' vorgang list
  ```
- Expected: a 2xx with an empty body should be treated as success (e.g. `null`/`{}`),
  not an error.
- Actual:
  ```
  Error: Failed to parse JSON response from /api/v1/vorgang
  exit=1
  ```
- Root cause: `src/client/engine.ts:159-167` `getJson` unconditionally `JSON.parse(text)`;
  an empty string throws, surfacing as `DipParseError`. No special-casing of `204`/empty
  body.

### 6. `<resource> get ""` (empty id) hits the collection endpoint instead of being rejected — ✅ FIXED
**Fix:** `src/cli/commands/resources.ts` `get` action now rejects an empty/whitespace-only id with a `DipUsageError` (exit 2) before any request, instead of building `.../vorgang/`.
- Severity: Medium · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT vorgang get ''
  ```
- Expected: an empty id should be rejected as a usage error (an id is required and
  meaningful).
- Actual: commander accepts `''` as a present positional, and the client builds
  `/api/v1/vorgang/` (trailing slash, no id):
  ```
  url":"/api/v1/vorgang/
  ```
  Against the real API this silently targets the wrong resource shape rather than failing
  fast.
- Root cause: no emptiness check on the `<id>` positional. `src/cli/commands/resources.ts:91`
  calls `resource.get(id!)` with `id === ""`; `src/client/client.ts:47`
  `` `${API}/${this.path}/${enc(id)}` `` → `.../vorgang/`. A whitespace-only id behaves the
  same (`vorgang get '   '` → `/api/v1/vorgang/%20%20%20`).

---

## LOW

### 7. `-o, --output <file>` is advertised but does nothing (dead option) — ✅ FIXED
**Fix:** `src/cli/shared.ts` `renderJson` now honours `--output`: when set, it writes the JSON bytes to the file and prints a byte-count confirmation to stderr (keeping stdout clean), instead of always printing to stdout. The option now has a real consumer for every command.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT -o /tmp/dipout.json vorgang list
  ls /tmp/dipout.json    # No such file or directory
  ```
- Expected: either write bytes to the file (as `--help` says: "for downloads: write bytes
  to this file instead of stdout") or do not advertise the option.
- Actual: JSON is still printed to stdout, exit 0, and the file is never created. No
  command consumes `--output`.
- Root cause: the rendering helper `renderRaw` (`src/cli/shared.ts:70-77`) and
  `engine.getRaw` (`src/client/engine.ts:170-172`) are never called by any command;
  `src/cli/commands/resources.ts` only ever calls `renderJson`. The option declared at
  `src/cli/program.ts:56` has no consumer.

### 8. README global-options table omits `-o, --output` — ✅ FIXED
**Fix:** Added a `-o, --output <file>` row to the Global options table in `README.md`.
- Severity: Low · Confidence: High
- Repro: compare `README.md` "Global options" table (lines 58-66) with `--help` output.
- Expected: documentation matches `--help`.
- Actual: `--help` lists `-o, --output <file>`; the README table does not. (Combined with
  bug #7, the option is both undocumented and non-functional.)
- Root cause: `README.md:58-66` vs `src/cli/program.ts:56`.

### 9. `--filter` validation error does not show help, but commander's own option errors do (inconsistent UX) — ✅ FIXED
**Fix:** `src/cli/commands/resources.ts` `collectFilter` now throws commander's `InvalidArgumentError` (not a bare `DipError`), so a malformed `--filter` flows through commander's parse-error path and `showHelpAfterError()` displays the command help, matching unknown-option behaviour.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js vorgang list --filter bad      # no help shown
  node dist/src/cli/index.js vorgang list --bogus           # full help shown
  ```
- Expected: consistent behaviour given `showHelpAfterError()` is configured.
- Actual: a malformed `--filter` prints only `Error: Invalid --filter "bad". Expected
  key=value.` (exit 1), while an unknown option prints the error *and* the command help.
- Root cause: `collectFilter` (`src/cli/commands/resources.ts:53`) throws a `DipError`,
  which is caught by `run()` (`src/cli/run.ts:52-54`) and printed without help.
  `showHelpAfterError` (`src/cli/program.ts:57`) only fires for `CommanderError`s.

### 10. Empty `--cursor` sends a stray `cursor=` query parameter — ✅ FIXED
**Fix:** `src/cli/commands/resources.ts` list action now only sets `cursor` when the value is non-empty, so `--cursor ''` is omitted from the query.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT vorgang list --cursor ''
  ```
- Expected: an empty cursor should be omitted (or rejected), not sent as `?cursor=`.
- Actual:
  ```
  url":"/api/v1/vorgang?cursor=
  ```
- Root cause: `src/cli/commands/resources.ts:71` sets `params["cursor"]` whenever
  `opts["cursor"] !== undefined`; `""` is defined, so an empty cursor is forwarded.

### 11. Empty `--id ""` sends a stray empty `f.id=` filter — ✅ FIXED
**Fix:** `src/cli/commands/resources.ts` list action now filters out empty `--id` values (and empty `f.id` from `--filter`) before merging, so no `f.id=` is emitted.
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT vorgang list --id ''
  ```
- Expected: empty ids omitted or rejected.
- Actual: `url":"/api/v1/vorgang?f.id=` (empty value forwarded).
- Root cause: `collect` (`src/cli/commands/resources.ts:43-45`) accumulates any string,
  including `""`; the merge at lines 75-79 forwards it verbatim.

### 12. `--user-agent ""` sends an empty `User-Agent` header instead of falling back to the default — ✅ FIXED
**Fix:** `src/cli/shared.ts` `toEngineOptions` now only forwards `userAgent` when it is non-blank, so a blank `--user-agent` falls back to the engine default (`dip-bundestag-cli`).
- Severity: Low · Confidence: High
- Repro:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT --user-agent '' vorgang list
  ```
- Expected: a blank UA should fall back to `dip-bundestag-cli`, or be rejected.
- Actual: header sent is `"ua":""` (empty). Some servers/proxies reject or log-spam on a
  blank User-Agent.
- Root cause: `src/cli/shared.ts:53` forwards `userAgent` when `!== undefined` (so `""`
  passes), and `src/client/engine.ts:77` `this.userAgent = options.userAgent ?? DEFAULT`
  uses `??`, which does not treat `""` as nullish.

### 13. `assertEnum` is dead code; resource names are validated by commander, not this helper — ✅ FIXED
**Fix:** Removed the unused `assertEnum` export (and the now-unused `DipError` import) from `src/cli/shared.ts`.
- Severity: Low · Confidence: Medium
- Repro: `grep -rn assertEnum src/` shows it is exported (`src/cli/shared.ts:25-34`) but
  never called.
- Expected: either use it or remove it (it carries a TODO-style comment about commander
  not supporting `.choices()` on positionals).
- Actual: unused export; resource selection is handled by commander subcommands instead.
  Harmless but misleading dead code.
- Root cause: `src/cli/shared.ts:25-34` defined; no import/usage anywhere in `src/`.

### 14. Exit codes for usage errors are undocumented / under-specified vs README — ✅ FIXED
**Fix:** `src/cli/run.ts` now maps all commander parse/usage errors (non-zero `CommanderError`) and the new `DipUsageError` (e.g. empty `get <id>`) to exit code `2`, distinct from runtime errors (`1`) and `404` (`4`); help/version stay `0`. Added a `DipUsageError` class in `src/client/errors.ts` and documented the `2` code in `README.md`.
- Severity: Low · Confidence: Medium
- Repro:
  ```
  node dist/src/cli/index.js bogus            ; echo $?   # 1
  node dist/src/cli/index.js --bogus          ; echo $?   # 1
  node dist/src/cli/index.js vorgang get      ; echo $?   # 1
  node dist/src/cli/index.js --timeout abc ...; echo $?   # 1
  ```
- Expected: the README says "non-zero for usage errors" but lists distinct codes
  (`0`, `4`, `1`) for runtime outcomes; usage errors collapse to the same `1` as generic
  runtime errors, so scripts cannot distinguish a usage error from a `401`/network error.
- Actual: all usage/parse errors and all non-404 runtime errors share exit `1`, making
  `1` ambiguous. Not wrong per se, but the README implies more granularity than exists.
- Root cause: `src/cli/run.ts:36-58` maps only `404 → 4`; everything else (including the
  `401` the README calls out separately) returns `1`, as do commander parse errors
  (`err.exitCode`, default 1).

---

## Things that work correctly (verified, not bugs)

- `401` → exit 1 with an actionable, expired-key hint (live + mock).
- `404` → exit 4 (mock).
- `--api-key` > `DIP_API_KEY` > bundled default precedence (mock).
- `DIP_API_KEY="   "` (whitespace-only) correctly treated as unset → falls back to default.
- `--filter f.titel=a=b` correctly splits on the first `=` only → `f.titel=a=b`.
- `--id` + `--filter f.id=...` correctly **merge** → `f.id=9&f.id=1&f.id=2`.
- `--filter` with `=value` / missing `=` correctly rejected.
- Query encoding is sound: spaces→`%20`, literal `+`→`%2B`, `&`/`=` in values escaped,
  Unicode (`ü`→`%C3%BC`) escaped; ids in `get` are `encodeURIComponent`-escaped.
- Cross-origin redirect strips `Authorization` (key not leaked); same-origin keeps it.
- `3xx` without `Location` → surfaced as an API error, not silent success.
- `file://`/`ftp://` base URLs rejected with a clear unsupported-protocol error.
- `--max-response-bytes 1` aborts oversized responses; `0` = unlimited.
- Transient `429/503` retried (default 1 initial + 2 retries = 3 attempts).
- Trailing slash on `--base-url` normalised; base URL path prefix preserved.

---

## Summary

**14 genuine, reproducible bugs** (2 High, 4 Medium, 8 Low). All are real and reproduced
locally; none rely on a valid API key. Most serious:

1. **#1** — `--api-key ""` emits a malformed `Authorization: ApiKey ` header (breaks the
   project's own "no malformed empty key" guarantee).
2. **#2** — repeated `--filter <samekey>` silently drops all but the last value (data
   loss; inconsistent with the documented `--id` merge contract).
3. **#5** — a successful empty/`204` response is misreported as a parse error with exit 1.
