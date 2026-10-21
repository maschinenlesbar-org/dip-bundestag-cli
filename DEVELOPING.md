# Developing & integrating

This document covers `dip-bundestag-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`dip`) and a typed API client (`DipClient`) for
the [Bundestag DIP API](https://dip.bundestag.de/über-dip/hilfe/api)
(`search.dip.bundestag.de/api/v1`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https`
  (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed list envelope; documents exposed as faithful
  `JsonObject`s.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`),
  every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
dip --help
```

## Library usage

```ts
import { DipClient, DipApiError } from "@maschinenlesbar.org/dip-bundestag-cli";

const client = new DipClient({ apiKey: process.env.DIP_API_KEY });

const filters = { "f.titel": "Klimaschutz" };
const page = await client.vorgaenge.list(filters);
console.log(page.numFound, page.documents.length);
// Repeat the filters with the cursor: DIP does not bind a cursor to its query, so
// `{ cursor }` alone would return the next page of the *unfiltered* list; list()
// refuses it (DipValidationError) unless { allowUnfilteredCursor: true } is passed.
const next = page.cursor ? await client.vorgaenge.list({ ...filters, cursor: page.cursor }) : undefined;

const paper = await client.drucksachen.get("123456");

try {
  await client.vorgaenge.list();
} catch (err) {
  if (err instanceof DipApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new DipClient({
  apiKey: process.env.DIP_API_KEY, // Authorization: ApiKey <key>
  baseUrl: "https://search.dip.bundestag.de",
  timeoutMs: 15_000,
  maxRetries: 3,
  maxResponseBytes: 50 << 20,
  userAgent: "my-app/1.0",
  transport: customTransport,
});
```

Every option may be omitted or given as `undefined`, which means the same (the default),
so the example above compiles under `exactOptionalPropertyTypes` too.

### Resource groups

`client.vorgaenge`, `.vorgangspositionen`, `.drucksachen`, `.drucksacheText`,
`.plenarprotokolle`, `.plenarprotokollText`, `.aktivitaeten`, `.personen` — each
with `.list(params)` and `.get(id)`.

## Authentication internals

DIP requires an `Authorization: ApiKey <key>` header on every request. The key
is **not bundled** — it must be supplied via `apiKey` (library), `--api-key`
(CLI), or the `DIP_API_KEY` env var, else the header is omitted and the API
returns `401`. Precedence is **`--api-key` > `DIP_API_KEY` > the credentials
file > none**; no key is bundled, so without one supplied the `Authorization` header
is omitted entirely and requests return `401`.

The credentials file is the CLI's, not the library's: `apps/cli/src/cli/credentials.ts`
(`CredentialStore`, the same mechanism as openka-cli's `ka config`) and `dip config`
(`apps/cli/src/cli/commands/config.ts`). It reaches the CLI through `CliDeps.credentials`, which
only `defaultDeps` sets, so a test that does not ask for one never reads the user's
file; `action()` (`apps/cli/src/cli/shared.ts`) reads it only when neither the flag nor the env
var gave a key, and makes the value a secret of the run the moment it is read
(`deps.addSecret`, set by `run()`), so the log replaces it like a flag or env key. `config set` reads through `CliIO.readSecret` (`readSecretFrom`: raw
mode without echo on a terminal, the whole input from a pipe, at most 64 KiB either way),
never from argv. On a terminal it drops escape sequences (arrow keys, bracketed-paste
markers), keeps every other character (so a tab is refused, as from a pipe) and refuses
a paste with more after its first line break.

The Bundestag publishes a **public** key on its
[DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api) (stated there in
2026 as valid until the end of May 2027; check the page for the current key); a
personal key can be requested from `parlamentsdokumentation@bundestag.de`. For CI or
local live testing, take the key from that page and pass it in via `DIP_API_KEY`.

`obtain-key` (`packages/client/src/obtain-key.ts`, exposed as `dip obtain-key` and
`npm run obtain-key`) reads the published key and **verifies it against the live API
before printing it**. Unlike the old `scripts/fetch-api-key.mjs`, this ships with
the package.

**Where the key is read from.** The help page is a React single-page app — its
served HTML holds no key — but the prose it renders is a plain JSON document from
DIP's own content service, and that document states the key:

```
https://content.dip.bundestag.de/content-api/v1/content/help-api
```

That is `KEY_SOURCE_URL`, tried first. The
[bundesAPI README](https://github.com/bundesAPI/dip-bundestag-api) is kept as
`KEY_SOURCE_FALLBACK_URL` and tried only if the help document is unreachable or its
key is rejected; its key has been rejected with `401` since at least 2026-09-15.
Until 2026-09-17 the README was the *only* source, which is why `obtain-key` failed
outright — reading the help document is the fix.

**How a key is picked out of a document.** A JSON document (the help document is one) is read
as its decoded strings, so markup an encoder escaped (`\u003cbr /\u003e`) reads as `<br />`;
anything else, or JSON nested too deeply to walk, as text. `extractKeyCandidates` returns every
key-shaped string (`prefix.body`), labelled forms first: the help document's
`… gültige API-Key lautet:<br />…` and the README's `Authorization: ApiKey …`, then
anything else token-shaped, capped at five per source. Each candidate is verified in
turn, so a reworded sentence degrades to "try the other matches" rather than to
failure. Only a value of that exact shape (`A–Z a–z 0–9 _ -`, 6–12 characters, a
dot, 30–48 characters, ending there: a longer token is no candidate rather than one cut to
fit, which would fail verification as a rejected key) can be a candidate, so a placeholder (`YOUR-API-KEY`), a flag,
punctuation or a terminal escape is never printed as the key, `--no-verify`
included. Only a 401 from the origin that received the key rejects it; any other
status (a 403 from a WAF included), an answer from another origin, or a 2xx that is
not a DIP list is treated as *the API being unwell*, not as a bad key, and aborts
instead of walking the rest. `--no-verify` prints the first candidate unchecked with
a loud warning (the CLI logs it as a `WARN` record of `dip.obtain-key`; a verified key is an
`INFO`). When a source redirects, `sourceUrl` (and the CLI's note) names the
document the key was actually read from.

Do **not** read the portal's own `https://dip.bundestag.de/dip-config.js`
(`portalApiKey`): that is the web front end's internal credential, scoped to the
portal services, and it is rejected with `401` on `/api/v1/`.

**Redirect safety.** Credentials — the API key, the credential headers
(`Authorization`, `X-API-Key`, `Cookie`) and a base URL's `user:password@`, which
goes out as `Authorization: Basic` unless an API key takes that header — are
attached by the engine per hop, never baked into the URL the transport sees. They
go to the base URL's origin only: a same-origin redirect (relative or absolute
`Location`) keeps them; a redirect to another scheme, host or port **drops them**
for the rest of the chain, so your key is never sent to a host other than the one
you targeted. That includes http→https on the same host: DIP answers plain http
with a 301 to https, the key is withheld there, and the resulting 401 says "use an
https base URL" instead of blaming the key (`DipApiError.credentialsDropped`; the
CLI then skips its "check your API key" hint). The transport is told
`redirect: "manual"` (`HttpRequest.redirect`); a transport that follows a redirect
itself and reports a final `url` on another origin fails the request with a
`DipNetworkError`. `obtain-key` only counts an answer from the origin that received
the key as verification. The CLI warns on stderr (a `WARN` record of `dip.http`, once per run, before the first request;
`obtain-key` only when it verifies) whenever the base URL is plain `http:` to a host
other than the loopback interface, naming the API key or userinfo that goes with it
(`cleartextProblem`, exported; `cleartextCredentialsProblem` is its deprecated alias). `apps/cli/test/conformance-p3-redirect-credentials.test.ts`
is the shared check (two local origins, a fetch transport, the http→https hint and
the verification rule). Only 301/302/303/307/308 with a parseable
`Location` are followed, up to `maxRedirects` (5); anything else — another 3xx, a
missing or malformed `Location`, or the limit — is a `DipApiError` whose message
names the target: `redirect to <url> not followed`, plus `(stopped after 5
redirects)` when the limit ended a loop.

## Architecture

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/dip-bundestag-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/dip-bundestag-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/dip-bundestag-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { DipClient } from
  "@maschinenlesbar.org/dip-bundestag-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/dip-bundestag-client/internal/engine`) for what
  the CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace. `obtain-key` is split the same way: reading and verifying the key
  (`obtainKey`) is the client's, the `dip obtain-key` command, `dip config` and the
  credentials file are the CLI's.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    types.ts     # ListResult (cursor envelope); documents as JsonObject
    query.ts     # dependency-free query-string builder
    filters.ts   # LIST_FILTERS: the f.* filters each list endpoint accepts (OpenAPI 1.5)
    validate.ts  # input rules (…Problem functions) + assertValid
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # DipError / DipApiError / DipNetworkError / DipParseError / DipUsageError / DipValidationError
    client.ts    # DipClient — one generic ResourceGroup per resource (injects Authorization)
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver (incl. --api-key), JSON renderer
    commands/    # the eight resource command groups (list / get)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The engine accepts `defaultHeaders` merged into every request — the seam used
  to inject `Authorization: ApiKey <key>`. The CLI surfaces it as `--api-key`
  (or `DIP_API_KEY`).
- The eight resources share one generic `ResourceGroup`, so adding a resource is
  a one-line change (plus its filter set in `filters.ts`).
- DIP ignores unknown query keys and then returns the unfiltered list, so the
  library's `list(params)` rejects every key that is not in `LIST_FILTERS` (taken
  from the official OpenAPI description,
  `https://search.dip.bundestag.de/api/v1/openapi.yaml`) or `cursor`, with
  `DipValidationError` before the request (`filterKeyProblem`). The CLI's
  `--filter` uses the same check. When DIP adds a filter, add it there; until
  then `list(params, { allowUnknownFilters: true })` sends it anyway.
- DIP does not keep a page's filters in its cursor either, so `list()` rejects a
  `cursor` sent without any filter (`cursorWithoutFiltersProblem`) unless
  `{ allowUnfilteredCursor: true }` asks for the unfiltered list; the CLI refuses a
  bare `--cursor` as a usage error in a `preAction` hook (before any warning or request).
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

### Library input validation

`apps/cli/test/conformance-p10-strict-filters.test.ts` is the shared check that a filter DIP
would ignore never goes out (unknown, misspelled or `__proto__` keys, blank or non-integer
values, keys spelled differently), that a repeated `--filter` is combined (DIP's OR set), and that
a repeated single-value option is a usage error (`forbidRepeatedOptions`, in `apps/cli`).

The library owns every rule about what a request may contain; the CLI only turns
argv strings into typed values and calls the same rules. The rules are pure,
exported `…Problem(value)` functions (they return the reason a value is invalid,
or `undefined`). The client enforces them before any request through
`assertValid(name, value, problem)` (`packages/client/src/validate.ts`), which throws
**`DipValidationError`** (`Invalid <name>: <reason>`); a client method rejects
its promise, a constructor throws. `DipValidationError` extends `DipUsageError`,
so `run.ts` maps it to exit 2 and logs it as an `ERROR` record of `dip.cli`. The CLI's commander
parsers call the same functions and turn a reason into commander's
`InvalidArgumentError` (exit 2 too).

What the library rejects:

- **Wrong types** (JavaScript callers): every rule checks the type first, so a
  wrong-typed input is a `DipValidationError`, never a raw `TypeError` — params or
  options that are not a plain object, a filter value that is not a string, finite
  number, boolean or valid Date (`[object Object]`, `NaN`), a `cursor` that is not
  one string, an id that is neither a string nor a non-negative integer, a
  non-string `apiKey`/`userAgent`/`baseUrl`/header value, `defaultHeaders` that are
  not an object, a `transport` or `sleep` that is not a function, and a `sourceUrl`
  for `obtainKey` that is not an absolute http(s) URL.
  `apps/cli/test/conformance-p8-p9-p13-responses-and-errors.test.ts` is the shared check
  (its bad calls use an offline transport, so a call that slipped through could never
  reach the live API). A server `detail` is cut at 500 characters in a message, never inside a surrogate
  pair (`cutText`), so the message stays well-formed; any other value an own message
  quotes from a server answer or the user's input (a redirect target, a charset or
  Content-Type, a key, an unknown filter, a `--filter` value) at `MAX_QUOTED_LENGTH`
  (200, `cutForMessage`), so `err.message` stays bounded for a library caller.
- **Blank list parameters** (`assertNonBlankParams`, called first in every
  `list()`): a blank parameter name, a blank string value, an empty array or a
  blank array element, `cursor` included. DIP treats an empty parameter as no
  filter and answers with the whole unfiltered list. `undefined`/`null` still
  mean "omitted". The CLI's `parseNonEmpty` and `--filter` checks use the same
  `nonEmptyProblem`/`isBlank`, as early parse-time copies.
- **Text filters** (`normalizeText`, for the `TEXT_FILTERS` in every `list()`): the value of a
  filter DIP matches as words or names (`f.titel`, `f.person`, `f.urheber`, `f.deskriptor`,
  `f.sachgebiet`, …) goes out trimmed and in composed Unicode (NFC); a pasted trailing space
  or a decomposed `Müller` matched nothing, with exit 0. Every other string value is sent
  composed but otherwise as given: codes, document numbers, dates and the cursor. A value
  blank once trimmed is refused first (above). The CLI's `--filter` reaches the same `list()`.
- **Integer filters** (`integerFilterProblem`, for the `INTEGER_FILTERS` in every
  `list()`, `allowUnknownFilters` or not): a value of `f.id`, `f.wahlperiode`,
  `f.vorgang` and the other filters DIP's OpenAPI types as integers that is not a
  non-negative safe integer or a string of ASCII digits. DIP answers
  `f.wahlperiode=abc` with `400 … Invalid cursor` and a non-numeric id with 0 hits.
  A whole number past `Number.MAX_SAFE_INTEGER` is refused with its own reason
  (`at most 9007199254740991`); leading zeros don't count towards it.
  The CLI's `--filter` and `--id` parsers call the same function.
- **`get` id** (`idProblem`, in every `get(id)`, on the id trimmed of surrounding
  whitespace, which is also what is sent, an all-digit id without its leading zeros): a blank id (an empty last
  path segment would request the collection endpoint and resolve with the list
  envelope typed as a `Document`), `.` or `..` (`encodeURIComponent` leaves
  them and URL parsing resolves them to the list or the API root), and an id with a `/`
  (sent as `%2F`, which a server or proxy that decodes it reads as more path segments). The message
  names the resource (`Invalid drucksache id: An id is required, e.g. 123456.`);
  the CLI's `get <id>` has no check of its own and prints it as is.
  `RequestEngine.buildUrl` also rejects a dot segment with `DipValidationError`,
  as a backstop for callers of the engine.
- **Engine limits** (`validateLimits`, in the `RequestEngine` constructor, which
  `obtainKey` builds too): `timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries`
  0..`MAX_RETRIES` (10), `maxRedirects` 0..`MAX_REDIRECTS` (10), `retryDelayMs`
  and `maxResponseBytes` any non-negative safe integer. A negative, fractional,
  `NaN` or infinite value used to switch the timeout or the size cap off, or
  retry without end. The CLI's `parseBoundedInt` uses the same
  `intInRangeProblem` and the exported constants.
- **Header values** (`assertHeaderValue`/`headerValueProblem`, in the
  `RequestEngine` constructor, so in `obtainKey` too): a `userAgent` or
  `defaultHeaders` value that is blank, holds a control character other than
  tab, or a character above U+00FF; a `defaultHeaders` name that is not an HTTP
  token. Only `undefined` selects `DEFAULT_USER_AGENT`, in the client and in
  `obtainKey` alike. The CLI's `parseHeaderValue` wraps `headerValueProblem`.
- **Base URL** (`validateBaseUrl`/`baseUrlProblem`, in the `RequestEngine`
  constructor, so in `obtainKey` too whenever `baseUrl` is given, on the raw value
  before the trailing-slash strip): a value that does not parse as an absolute
  URL, a scheme other than `http:`/`https:`, a query or fragment (paths are
  appended to the raw string), surrounding whitespace, whitespace or a control
  character inside (`new URL()` would hide both), a `%` in the user name or
  password that is not an escape (Node would fail to decode it at request time),
  and a path ending in `/api/v1`
  (the client adds it; the message suggests the value without it). All of these
  are a `DipValidationError` (a configuration error), not a `DipNetworkError`;
  that class stays for the default transport's per-hop checks. Only `undefined`
  selects `DEFAULT_BASE_URL`. The CLI's `parseBaseUrl` only wraps
  `baseUrlProblem`, so `--base-url` and `baseUrl` give the same reason.
- **API key** (`normaliseApiKey`/`apiKeyProblem`, in the `DipClient`
  constructor): the key is trimmed and a blank one means no key; a key with a
  control character, a character above U+00FF or whitespace inside (a tab or space from a
  paste: a key is one token, as the credentials file already required) is rejected.
  The CLI's `--api-key` parser (after its own blank-flag check) and the
  `DIP_API_KEY` path end up in the same function, so all three send the same
  header or fail the same way (exit 2).
- **Secrets in the CLI's output** (`redactionFor` and `withRedactedOutput` in
  `run.ts`): commander echoes a rejected value in its usage error and names an
  unknown command or option as typed, so `run()` wraps `deps.io` and builds the log
  first. The log replaces the secrets in each record's *message*, before the record
  is cut and escaped, and writes it to the raw stderr: the frame (time, level, topic)
  is never touched, and a secret with DEL, C1 or bidi characters is matched in its
  raw form. The userinfo of every
  URL argument (`credentialsIn`, which finds it whether the value parses or
  not, then `redactCredentials`) becomes `***@` on stdout and stderr. Only a value
  that starts with a scheme counts (a bare `a:b@c` is a file name, a search text or a
  User-Agent as often as a credential), except as the `--base-url` value; the
  `--api-key` value, the `DIP_API_KEY` value and any argument shaped like a DIP
  key (`looksLikeApiKey`), or whose value after the first `=` is (`--filter f.titel=<key>`),
  become `***` on stderr (`redactSecrets`). Not on stdout,
  where `obtain-key` prints the key. The forms a server echoes a userinfo back in
  are replaced too: the `Basic` value and the decoded `user:password` on stdout and
  stderr, the password alone (4 characters or more) on stderr only, since it may
  well occur in the data. `apps/cli/test/conformance-p1-cli-redaction.test.ts`
  is the shared check (ten passwords, seven URL shapes, every echo path, plus the
  key by flag, by environment and typed without its flag).
- **Secrets in the library's objects and errors.** The engine keeps the base URL
  and the default headers (with the API key) in real `#private` fields, so
  `console.log(client)`, `util.inspect` and `JSON.stringify` never show them. The
  base URL's userinfo (raw and percent-decoded), the forms a server echoes it back
  in (the `Basic` value, the decoded `user:password`, the password alone from 4
  characters: `echoedCredentialForms`) and the key are scrubbed from
  error bodies and details, from transport error text and from the `cause` chain
  (`scrub`/`scrubCause`). `obtainKey` names a source URL without its userinfo, in
  its errors and in `ObtainedKey.sourceUrl`.
  `apps/cli/test/conformance-p2-library-redaction.test.ts` is the shared check.

### Library / technical terms

**API client.** [`DipClient`](packages/client/src/client.ts) — the typed,
resource-grouped wrapper over the API. Usable as a library independently of the
CLI. Each resource is a generic **ResourceGroup** with `.list(params)` and
`.get(id)`.

**ListResult.** The cursor-paginated list envelope returned by `list`:
`{ numFound, documents, cursor? }` ([`types.ts`](packages/client/src/types.ts)).

**Document.** A single resource document, typed as a faithful raw `JsonObject`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Custom transports.** The engine holds the contract for every transport, not only
the built-in one. `timeoutMs` is enforced by the engine: the transport gets an
`AbortSignal` (`HttpRequest.signal`) that fires at the deadline, and the call
rejects then whether the transport stops or not, so a `fetch` transport can't hang
a caller. `maxResponseBytes` is checked on the body any transport returns (the
built-in one aborts early). A body may be a Buffer, any `ArrayBuffer` view
(fetch's `Uint8Array`, from any realm), an `ArrayBuffer` or a string; headers may be
a plain record in any case, a `Headers` object or a `Map`. Whatever a transport
throws becomes a `DipNetworkError` naming the request (the original as `cause`): the
built-in transport's own errors and the engine's deadline and size cap too
(`GET <url> failed: Request timed out after 500ms`, `… failed: connect ECONNREFUSED …`,
`… failed: Response exceeded maxResponseBytes …`), and
a malformed response (no numeric status, no headers object, no body) is one too. A
reset reported as `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's `UND_ERR_SOCKET`
anywhere in the `cause` chain (`isTransientNetworkError`) is retried for a GET like a
503. A redirect to anything but an `http:`/`https:` URL is never handed to the
transport; it surfaces as a `DipApiError` naming the target.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes
JSON/raw responses and maps errors. Sits between the client's resource methods
and the transport. `obtainKey` uses one too: `getAbsolute(url)` reads the key
sources and `request()` with a per-request `Authorization` header verifies a
candidate, so both get the same timeout, size cap, retries and redirect policy
as every other request (`ObtainKeyOptions` takes the matching `EngineOptions`).

**Default headers.** The engine merges `defaultHeaders` into every request —
the seam that injects `Authorization: ApiKey <key>`. Names and values are
checked when the engine is built (see
[Library input validation](#library-input-validation)).

**Retry / backoff.** Transient `429` (rate limit) and `503` responses, and
reset connections (`isTransientNetworkError`), are retried automatically for a
GET, up to `--max-retries` (0–10). Each retry backs off linearly
(`retryDelayMs * attempt`; `retryDelayMs` 0..`MAX_RETRY_AFTER_MS`, default 200).
A `Retry-After` (`parseRetryAfter`: delay-seconds or an IMF-fixdate) can make a
wait longer, never shorter: `Retry-After: 0` or a past date still waits the
backoff, so retries never burst. One above `MAX_RETRY_AFTER_MS` (30 s) is not
retried — retrying sooner would only land inside the window — and the
`DipApiError` names the requested wait. When a reset ends the request, the `DipNetworkError`
names it and the retries spent (`GET <url> failed: socket hang up (after 2 retries)`), with
the transport's error as its `cause`.
`apps/cli/test/conformance-p6-retry-policy.test.ts` is the shared check (`OVER_CAP: "fail"`). `DipApiError`
exposes `isRetryable` (true for `429`/`503`).
Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed. The CLI's `action()` sets it to log one `WARN` record of
`dip.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s` (`retryMessage`; host only, whole
seconds, ms under 1 s). Tests: `packages/client/test/engine.test.ts`, `apps/cli/test/retry-log.test.ts`.

**Cross-origin credential stripping.** The engine attaches the credentials per
hop and only to the base URL's origin; a redirect to a different scheme, host or
port drops them for the rest of the chain (see *Redirect safety*), so the key is
never forwarded to another host.

**maxResponseBytes.** A cap on the response body size in bytes (`0` =
unlimited; default 100 MiB), guarding against unbounded responses.

**RawResponse.** The engine's raw-response shape: `{ data: Buffer,
contentType, status, url, credentialsDropped? }` — raw bytes, never lossily
decoded. `getJson` (and `obtainKey` for its source documents) decode them by the
charset the Content-Type names (`decodeBody`, UTF-8 when none; a BOM is dropped,
an unknown label is a `DipParseError`). A body with a number JSON.parse cannot carry
exactly — one out of a double's range (`1e400`, which printed as `null`), one past 2^53
that prints as a different number, in any form (`12345678901234567890`, which prints as
`12345678901234567000`, `12345678901234567890.0`, `9007199254740993e0`, `9007199254740992.5`),
a non-zero one too small for a double (`1e-400`, which became `0`), or a subnormal one (below
2.2250738585072014e-308, where a double has fewer digits) that does not print as written (`3e-324`,
which printed as `5e-324`; `5e-324` itself passes) — is a `DipParseError` too
(`GET <url>: the number … cannot be represented exactly.`), never a
changed value; below 2^53 a decimal fraction keeps a double's usual precision. Past 2^53 the
check compares the number as written with the number as printed (`String(value)`), not with
the double's exact binary value: a double a server printed in its shortest form (`1E23`,
`1.7976931348623157E308`) reads back as the same double, prints as the same number and passes.

**Query builder.** [`buildQueryString`](packages/client/src/query.ts) — a
dependency-free serialiser: omits `undefined`/`null`, repeats keys for arrays,
renders booleans as `true`/`false`, `Date`s as full ISO-8601 UTC instants (right
for `f.aktualisiert.*`; DIP rejects them for `f.datum.*`, so pass
`"YYYY-MM-DD"` strings there), and encodes spaces as
`%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**`help` command.** `run.ts` replaces commander's built-in `help [command]` on every
command with subcommands by its own `help [command...]` (in `configureTree`, so the
tree `buildProgram()` gives the website stays as commander builds it). It walks every
name: `dip help vorgang list` shows the `list` help (exit 0), and an unknown name is
parsed by the command it was meant for, so `dip help nope` and `dip vorgang help nope`
fail exactly like `dip nope` and `dip vorgang nope` (`error: unknown command 'nope'`,
suggestion and help included, redacted, exit 2). The built-in one read only the first
name and printed the root help with no word about the unknown one. A command
without subcommands is never run on the rest of the names: `dip help vorgang list nope` is an
unknown command `nope` and sends no request.

**Closed pipes.** The bin shim installs `handleOutputErrors()` before `run()`. A
reader that stops early (`| head`, `| jq` exiting on the first match) closes
stdout, and the next write fails with EPIPE (ENOTCONN when stdout is a socket, as
when a Node parent spawns the CLI with piped stdio on macOS): the process exits 0 at
once, quietly. Any other stdout write error is an ERROR record of `dip.output`
(`Could not write to stdout: …`, in the format argv asks for: `processLogger`) and exits
1. On stderr an EPIPE or ENOTCONN is ignored, so a failed run keeps its exit code (`2>&1 | true`
no longer turns a usage error into 0). `apps/cli/test/conformance-p7-pipes-exit-codes.test.ts`
runs the built bin to check both.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `DipApiError` (non-2xx,
carries `status`/`detail`/`url`/`method`/`body`, with `isRetryable` for
`429`/`503`), `DipNetworkError` (transport failure/timeout; never an invalid
base URL, which is a `DipValidationError`), `DipParseError`
(bad JSON, or a 2xx body without the documented shape: `list()` requires a list
envelope — `numFound`, `documents` — and `get()` a document with an `id`, checked
by `listResultProblem`/`documentProblem`, so `null`, `[]`, a string or an error
object is never printed with exit 0; every such message names the request, `GET <url>: …`
with the base URL's userinfo as `***@`, as a network error does: `the answer is not valid JSON`
(plus the Content-Type when it isn't JSON), `empty response body`, `unexpected response shape:
…`, `unsupported response charset "…"`), `DipUsageError` (a usage error — no request made) and its subclass
`DipValidationError` (the library rejected an input before any request, see
[Library input validation](#library-input-validation)), all extending `DipError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`, `types`),
everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback
  `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, `429`/`503`
  retry, redirect following + `maxRedirects`, cross-origin credential stripping,
  network-error propagation, `maxResponseBytes=0` — mocked transport.
- **`client.test.ts`** — the `Authorization` header, per-resource paths, cursor
  and filter params — mocked transport.
- **`types.test.ts`** — a consumer file compiled with `exactOptionalPropertyTypes` against
  the built declarations (it starts `tsc`, so it gets 30 s).
- **`cli.test.ts`** — command parsing, `--api-key`/`--filter`/`--id`, and exit
  codes — mocked client.
- **`validate.test.ts`** — `assertValid`, `DipValidationError` and its exit code.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (only
  each file's adapter block differs): P1/P2 redaction, P3 redirect credentials,
  P4/P19 configuration validation, P5 transport contract, P6 retry policy, P7 pipes
  and exit codes, P8/P9/P13 responses and errors, **P20** the plain-`http:` warning
  (`conformance-p20-cleartext-warning.test.ts`; its base-URL-variable case is
  skipped, dip has `--base-url` only), **P21** README links
  (`conformance-p21-readme-links.test.ts`: README ships to npmjs.com, so a relative
  link may only point at a file `package.json` `files` ships; the rest are absolute
  `https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/…` URLs),
  **P24** the input corpus (`conformance-p24-input-corpus.test.ts`: every text filter,
  `TEXT_FILTERS` on each resource that takes it, and every `get` id, through the CLI and the
  library: sent canonical or refused, never blank, a dot segment or with a `/`), **P25** the
  response corpus (a number a double can't carry exactly, or an empty body, is an error) and
  **P26** `-o` integrity (`ulimit -f` cuts the write: the old file stays, nothing half-written
  is left; an existing file is refused before any request; it starts the bin, 30 s). P24 and
  P25 use `kitParity`, dip's `parity` in the shape the shared bodies expect.
- **Parity tests** use `parity()` from `apps/cli/test/helpers.ts`: one input goes through
  `run()` and through a library call on one recording mock transport, and the
  test asserts the same outcome (both reject with no request, or both send the
  identical request).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*`
  tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/dip-bundestag-cli/> in English and
<https://maschinenlesbar.org/dip-bundestag-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/dip-bundestag-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `dip.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors),
`api` (the API's answers: an error status, and a malformed answer, a `DipParseError`:
bad JSON, the wrong shape, an empty body), `http` (the connection, the cleartext warning), `config`,
`obtain-key` and `output` (the `-o` file written, or any failure to write it: an
`OutputError`, and a stdout write error). A `-o` target refused before any request
(`checkOutputTarget` in `action()`: an existing path without `--force`, a dangling link
included, a directory, `--force` without `-o`) is a usage error of `cli`, exit 2; the write
checks again, so a file that appears during the request is an `OutputError`. Code logs through `logOf(deps)` and never writes diagnostics
with `io.err` directly. `run()` builds the logger from argv before commander parses it
(`logFormatFromArgv`, used only for the records of a parse error; a `preAction` hook then
sets the format commander parsed, so `--user-agent --log-format=jsonl` logs text),
so commander's own usage errors are records too: its `error: …` an ERROR of `cli` (a
`(Did you mean …?)` line joined to it), the help it shows after one an INFO record per
line, and a command group run without its subcommand an ERROR "missing command:
`dip vorgang <subcommand>`" before that help, so every failed run has an ERROR record
(`writeCommanderErr`). The log is built with the run's redaction
(`withRedactedOutput`), which replaces a secret in the message only, before it is
escaped: the frame is never touched, and a secret is kept out of the log in either format. Node's own process warnings (`NODE_TLS_REJECT_UNAUTHORIZED=0`) are WARN records of
`dip.cli` too: the bin shim installs `installWarningLog`, which removes Node's default
`warning` listener and logs `(node) <name>: <message>` through `processLogger(argv)`.
In `defaultDeps` a record waits for stdout (`stderrAfterStdout`): it is held while stdout
has a backlog and written, in order, once it is gone, so with `2>&1 |` and a slow reader
it never lands inside the data. `CliDeps.now` makes the timestamps
testable. stdout carries data only. Conformance test P23 checks all of this, and its
body is shared across the *-cli repos.

