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
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
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
// `{ cursor }` alone returns the next page of the *unfiltered* list.
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

### Resource groups

`client.vorgaenge`, `.vorgangspositionen`, `.drucksachen`, `.drucksacheText`,
`.plenarprotokolle`, `.plenarprotokollText`, `.aktivitaeten`, `.personen` — each
with `.list(params)` and `.get(id)`.

## Authentication internals

DIP requires an `Authorization: ApiKey <key>` header on every request. The key
is **not bundled** — it must be supplied via `apiKey` (library), `--api-key`
(CLI), or the `DIP_API_KEY` env var, else the header is omitted and the API
returns `401`. Precedence is **`--api-key` > `DIP_API_KEY` > none**; no key is
bundled, so without one supplied the `Authorization` header is omitted entirely
and requests return `401`.

The Bundestag publishes a **public** key on its
[DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api) (stated there in
2026 as valid until the end of May 2027; check the page for the current key); a
personal key can be requested from `parlamentsdokumentation@bundestag.de`. For CI or
local live testing, take the key from that page and pass it in via `DIP_API_KEY`.

`obtain-key` (`src/client/obtain-key.ts`, exposed as `dip obtain-key` and
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

**How a key is picked out of a document.** `extractKeyCandidates` returns every
key-shaped string (`prefix.body`), labelled forms first: the help document's
`… gültige API-Key lautet:<br />…` and the README's `Authorization: ApiKey …`, then
anything else token-shaped, capped at five per source. Each candidate is verified in
turn, so a reworded sentence degrades to "try the other matches" rather than to
failure. Only a value of that exact shape (`A–Z a–z 0–9 _ -`, 6–12 characters, a
dot, 30–48 characters) can be a candidate, so a placeholder (`YOUR-API-KEY`), a flag,
punctuation or a terminal escape is never printed as the key, `--no-verify`
included. Only a 401 from the origin that received the key rejects it; any other
status (a 403 from a WAF included), an answer from another origin, or a 2xx that is
not a DIP list is treated as *the API being unwell*, not as a bad key, and aborts
instead of walking the rest. `--no-verify` prints the first candidate unchecked with
a loud warning. When a source redirects, `sourceUrl` (and the CLI's note) names the
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
the key as verification. The CLI warns on stderr (`warning: …`, once per run, before the first request;
`obtain-key` only when it verifies) whenever the base URL is plain `http:` to a host
other than the loopback interface, naming the API key or userinfo that goes with it
(`cleartextProblem`, exported; `cleartextCredentialsProblem` is its deprecated alias). `test/conformance-p3-redirect-credentials.test.ts`
is the shared check (two local origins, a fetch transport, the http→https hint and
the verification rule). Only 301/302/303/307/308 with a parseable
`Location` are followed, up to `maxRedirects` (5); anything else — another 3xx, a
missing or malformed `Location`, or the limit — is a `DipApiError` whose message
names the target: `redirect to <url> not followed`, plus `(stopped after 5
redirects)` when the limit ended a loop.

## Architecture

```
src/
  client/
    types.ts     # ListResult (cursor envelope); documents as JsonObject
    query.ts     # dependency-free query-string builder
    filters.ts   # LIST_FILTERS: the f.* filters each list endpoint accepts (OpenAPI 1.5)
    validate.ts  # input rules (…Problem functions) + assertValid
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # DipError / DipApiError / DipNetworkError / DipParseError / DipUsageError / DipValidationError
    client.ts    # DipClient — one generic ResourceGroup per resource (injects Authorization)
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
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
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

### Library input validation

The library owns every rule about what a request may contain; the CLI only turns
argv strings into typed values and calls the same rules. The rules are pure,
exported `…Problem(value)` functions (they return the reason a value is invalid,
or `undefined`). The client enforces them before any request through
`assertValid(name, value, problem)` (`src/client/validate.ts`), which throws
**`DipValidationError`** (`Invalid <name>: <reason>`); a client method rejects
its promise, a constructor throws. `DipValidationError` extends `DipUsageError`,
so `run.ts` maps it to exit 2 and prints `Error: <message>`. The CLI's commander
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
  `test/conformance-p8-p9-p13-responses-and-errors.test.ts` is the shared check
  (its bad calls use an offline transport, so a call that slipped through could never
  reach the live API). A server `detail` is cut at 500 characters in a message.
- **Blank list parameters** (`assertNonBlankParams`, called first in every
  `list()`): a blank parameter name, a blank string value, an empty array or a
  blank array element, `cursor` included. DIP treats an empty parameter as no
  filter and answers with the whole unfiltered list. `undefined`/`null` still
  mean "omitted". The CLI's `parseNonEmpty` and `--filter` checks use the same
  `nonEmptyProblem`/`isBlank`, as early parse-time copies.
- **`get` id** (`idProblem`, in every `get(id)`): a blank id (an empty last
  path segment would request the collection endpoint and resolve with the list
  envelope typed as a `Document`), and `.` or `..` (`encodeURIComponent` leaves
  them and URL parsing resolves them to the list or the API root). The message
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
  control character (other than tab) or a character above U+00FF is rejected.
  The CLI's `--api-key` parser (after its own blank-flag check) and the
  `DIP_API_KEY` path end up in the same function, so all three send the same
  header or fail the same way (exit 2).
- **Secrets in the CLI's output** (`withRedactedOutput` in `run.ts`): commander
  echoes a rejected value in its usage error and names an unknown command or
  option as typed, so `run()` wraps `deps.io` first. The userinfo of every
  URL-like argument (`credentialsIn`, which finds it whether the value parses or
  not, then `redactCredentials`) becomes `***@` on stdout and stderr; the
  `--api-key` value, the `DIP_API_KEY` value and any argument shaped like a DIP
  key (`looksLikeApiKey`) become `***` on stderr (`redactSecrets`). Not on stdout,
  where `obtain-key` prints the key. `test/conformance-p1-cli-redaction.test.ts`
  is the shared check (ten passwords, seven URL shapes, every echo path, plus the
  key by flag, by environment and typed without its flag).
- **Secrets in the library's objects and errors.** The engine keeps the base URL
  and the default headers (with the API key) in real `#private` fields, so
  `console.log(client)`, `util.inspect` and `JSON.stringify` never show them. The
  base URL's userinfo (raw and percent-decoded) and the key are scrubbed from
  error bodies and details, from transport error text and from the `cause` chain
  (`scrub`/`scrubCause`). `obtainKey` names a source URL without its userinfo, in
  its errors and in `ObtainedKey.sourceUrl`.
  `test/conformance-p2-library-redaction.test.ts` is the shared check.

### Library / technical terms

**API client.** [`DipClient`](src/client/client.ts) — the typed,
resource-grouped wrapper over the API. Usable as a library independently of the
CLI. Each resource is a generic **ResourceGroup** with `.list(params)` and
`.get(id)`.

**ListResult.** The cursor-paginated list envelope returned by `list`:
`{ numFound, documents, cursor? }` ([`types.ts`](src/client/types.ts)).

**Document.** A single resource document, typed as a faithful raw `JsonObject`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Custom transports.** The engine holds the contract for every transport, not only
the built-in one. `timeoutMs` is enforced by the engine: the transport gets an
`AbortSignal` (`HttpRequest.signal`) that fires at the deadline, and the call
rejects then whether the transport stops or not, so a `fetch` transport can't hang
a caller. `maxResponseBytes` is checked on the body any transport returns (the
built-in one aborts early). A body may be a Buffer, any `ArrayBuffer` view
(fetch's `Uint8Array`, from any realm), an `ArrayBuffer` or a string; headers may be
a plain record in any case, a `Headers` object or a `Map`. Whatever a transport
throws becomes a `DipNetworkError` naming the request (the original as `cause`), and
a malformed response (no numeric status, no headers object, no body) is one too. A
reset reported as `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's `UND_ERR_SOCKET`
anywhere in the `cause` chain (`isTransientNetworkError`) is retried for a GET like a
503. A redirect to anything but an `http:`/`https:` URL is never handed to the
transport; it surfaces as a `DipApiError` naming the target.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
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
`DipApiError` names the requested wait.
`test/conformance-p6-retry-policy.test.ts` is the shared check (`OVER_CAP: "fail"`). `DipApiError`
exposes `isRetryable` (true for `429`/`503`).

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
an unknown label is a `DipParseError`).

**Query builder.** [`buildQueryString`](src/client/query.ts) — a
dependency-free serialiser: omits `undefined`/`null`, repeats keys for arrays,
renders booleans as `true`/`false`, `Date`s as full ISO-8601 UTC instants (right
for `f.aktualisiert.*`; DIP rejects them for `f.datum.*`, so pass
`"YYYY-MM-DD"` strings there), and encodes spaces as
`%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Closed pipes.** The bin shim installs `handleOutputErrors()` before `run()`. A
reader that stops early (`| head`, `| jq` exiting on the first match) closes
stdout, and the next write fails with EPIPE (ENOTCONN when stdout is a socket, as
when a Node parent spawns the CLI with piped stdio on macOS): the process exits 0 at
once, quietly. On stderr an EPIPE or ENOTCONN is ignored, so a failed run keeps its exit code (`2>&1 | true`
no longer turns a usage error into 0). `test/conformance-p7-pipes-exit-codes.test.ts`
runs the built bin to check both.

**Error types.** [`errors.ts`](src/client/errors.ts): `DipApiError` (non-2xx,
carries `status`/`detail`/`url`/`method`/`body`, with `isRetryable` for
`429`/`503`), `DipNetworkError` (transport failure/timeout; never an invalid
base URL, which is a `DipValidationError`), `DipParseError`
(bad JSON, or a 2xx body without the documented shape: `list()` requires a list
envelope — `numFound`, `documents` — and `get()` a document with an `id`, checked
by `listResultProblem`/`documentProblem`, so `null`, `[]`, a string or an error
object is never printed with exit 0), `DipUsageError` (a usage error — no request made) and its subclass
`DipValidationError` (the library rejected an input before any request, see
[Library input validation](#library-input-validation)), all extending `DipError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback
  `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, `429`/`503`
  retry, redirect following + `maxRedirects`, cross-origin credential stripping,
  network-error propagation, `maxResponseBytes=0` — mocked transport.
- **`client.test.ts`** — the `Authorization` header, per-resource paths, cursor
  and filter params — mocked transport.
- **`cli.test.ts`** — command parsing, `--api-key`/`--filter`/`--id`, and exit
  codes — mocked client.
- **`validate.test.ts`** — `assertValid`, `DipValidationError` and its exit code.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (only
  each file's adapter block differs): P1/P2 redaction, P3 redirect credentials,
  P4/P19 configuration validation, P5 transport contract, P6 retry policy, P7 pipes
  and exit codes, P8/P9/P13 responses and errors, **P20** the plain-`http:` warning
  (`conformance-p20-cleartext-warning.test.ts`; its base-URL-variable case is
  skipped, dip has `--base-url` only), **P21** README links
  (`conformance-p21-readme-links.test.ts`: README ships to npmjs.com, so a relative
  link may only point at a file `package.json` `files` ships; the rest are absolute
  `https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/…` URLs).
- **Parity tests** use `parity()` from `test/helpers.ts`: one input goes through
  `run()` and through a library call on one recording mock transport, and the
  test asserts the same outcome (both reject with no request, or both send the
  identical request).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test,
  `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted
  Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*`
  tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/dip-bundestag-cli/> in English and
<https://maschinenlesbar-org.github.io/dip-bundestag-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/dip-bundestag-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
