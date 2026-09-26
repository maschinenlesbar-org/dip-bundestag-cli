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

const page = await client.vorgaenge.list({ "f.titel": "Klimaschutz" });
console.log(page.numFound, page.documents.length);
const next = page.cursor ? await client.vorgaenge.list({ cursor: page.cursor }) : undefined;

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
Same-origin redirects keep it.

## Architecture

```
src/
  client/
    types.ts     # ListResult (cursor envelope); documents as JsonObject
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # DipError / DipApiError / DipNetworkError / DipParseError / DipUsageError
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
  a one-line change.
- The HTTP layer is a single `Transport` function; the default uses
  `node:http`/`node:https` and tests inject a mock.
- The CLI is built around injectable `CliDeps`, so the whole program can be
  driven in-process by tests.

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
and the transport.

**Default headers.** The engine merges `defaultHeaders` into every request —
the seam that injects `Authorization: ApiKey <key>`.

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
renders booleans as `true`/`false`, dates as ISO-8601, and encodes spaces as
`%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `DipApiError` (non-2xx,
carries `status`/`detail`/`url`/`method`/`body`, with `isRetryable` for
`429`/`503`), `DipNetworkError` (transport failure/timeout), `DipParseError`
(bad JSON), and `DipUsageError` (a CLI usage error such as an empty `get` id —
no request made), all extending `DipError`.

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
