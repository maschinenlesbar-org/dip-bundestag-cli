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

Request a personal key from `parlamentsdokumentation@bundestag.de`. The
Bundestag also publishes a **shared** key (rate-limited, rotates yearly). For
CI or local live testing — never from the CLI/production — you can fetch the
current shared key out-of-band with the bundled script:

```bash
npm run fetch-key                                    # prints the current shared key
DIP_API_KEY="$(npm run --silent fetch-key)" dip vorgang list
```

The script scrapes the key from the upstream
[bundesAPI README](https://github.com/bundesAPI/dip-bundestag-api); it is a
dev/CI tool only and is not part of the published package.

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
retried automatically with backoff, up to `--max-retries`. `DipApiError`
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
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*`
  tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license —
see **[LICENSING.md](LICENSING.md)**. This project does **not** accept external
code contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
