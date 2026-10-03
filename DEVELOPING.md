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
failure. A non-401/403 verification status is treated as *the API being unwell*, not
as a bad key, and aborts instead of walking the rest. `--no-verify` prints the first
candidate unchecked with a loud warning.

Do **not** read the portal's own `https://dip.bundestag.de/dip-config.js`
(`portalApiKey`): that is the web front end's internal credential, scoped to the
portal services, and it is rejected with `401` on `/api/v1/`.

**Redirect safety.** When the API issues a redirect that crosses an origin
boundary (a different scheme, host, or port), the client **strips credential
headers** (`Authorization`, `X-API-Key`, `Cookie`) before following it, so
your API key is never sent to a host other than the one you targeted.
Same-origin redirects keep it. Only 301/302/303/307/308 with a parseable
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
- DIP ignores unknown query keys and then returns the unfiltered list, so the CLI
  checks every `--filter` key against `LIST_FILTERS` (taken from the official
  OpenAPI description, `https://search.dip.bundestag.de/api/v1/openapi.yaml`).
  When DIP adds a filter, add it there. The library's `list(params)` passes any
  key on unchecked.
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

- **Blank list parameters** (`assertNonBlankParams`, called first in every
  `list()`): a blank parameter name, a blank string value, an empty array or a
  blank array element, `cursor` included. DIP treats an empty parameter as no
  filter and answers with the whole unfiltered list. `undefined`/`null` still
  mean "omitted". The CLI's `parseNonEmpty` and `--filter` checks use the same
  `nonEmptyProblem`/`isBlank`, as early parse-time copies.
- **Blank `get` id** (`idProblem`, in every `get(id)`): an empty last path
  segment would request the collection endpoint and resolve with the list
  envelope typed as a `Document`. The message names the resource
  (`Invalid drucksache id: An id is required, e.g. 123456.`); the CLI's
  `get <id>` prints it as is.
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
  character inside (`new URL()` would hide both), and a path ending in `/api/v1`
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

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `--max-retries` (0–10). Each retry waits the
response's `Retry-After` (`parseRetryAfter`: delay-seconds or an IMF-fixdate)
up to `MAX_RETRY_AFTER_MS` (30 s) — a longer one is not retried, the error
surfaces at once — or else backs off linearly (`retryDelayMs * attempt`). `DipApiError`
exposes `isRetryable` (true for `429`/`503`).

**Cross-origin credential stripping.** When the API issues a redirect that
crosses an origin boundary (different scheme, host, or port), the engine strips
credential headers (`Authorization`, `X-API-Key`, `Cookie`) before following
it, so the key is never forwarded to another host.

**maxResponseBytes.** A cap on the response body size in bytes (`0` =
unlimited; default 100 MiB), guarding against unbounded responses.

**RawResponse.** The engine's raw-response shape: `{ data: Buffer,
contentType, status }` — raw bytes, never lossily decoded.

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

**Error types.** [`errors.ts`](src/client/errors.ts): `DipApiError` (non-2xx,
carries `status`/`detail`/`url`/`method`/`body`, with `isRetryable` for
`429`/`503`), `DipNetworkError` (transport failure/timeout; never an invalid
base URL, which is a `DipValidationError`), `DipParseError`
(bad JSON), `DipUsageError` (a usage error — no request made) and its subclass
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
- **Parity tests** use `parity()` from `test/helpers.ts`: one input goes through
  `run()` and through a library call on one recording mock transport, and the
  test asserts the same outcome (both reject with no request, or both send the
  identical request).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
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
