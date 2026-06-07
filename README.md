# dip-bundestag-cli

A TypeScript **API client** and **command-line interface** for the
[Bundestag DIP API](https://dip.bundestag.de/über-dip/hilfe/api)
(`search.dip.bundestag.de/api/v1`) — the **Dokumentations- und Informationssystem
für Parlamentsmaterialien**: Vorgänge, Drucksachen, Plenarprotokolle, Aktivitäten
and Personen of the German Bundestag and Bundesrat.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed list envelope; documents exposed as faithful `JsonObject`s.
- **Auth handled** — sends `Authorization: ApiKey <key>`; supply your key via `--api-key` / `DIP_API_KEY`.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Authentication

DIP requires an API key, sent as `Authorization: ApiKey <key>`.

> **A key is required.** The client ships the Bundestag's published **shared** key
> as a last-resort fallback, but that key **expired 2026-05-31**, so the
> zero-config path now returns `401`. Request a **personal** key from
> `parlamentsdokumentation@bundestag.de` and pass it via `--api-key` or the
> `DIP_API_KEY` environment variable. On a `401` the CLI prints an explicit hint
> telling you the bundled key is expired and how to supply your own.

Credential safety: the `Authorization` header (and `X-API-Key` / `Cookie`) is
**stripped on any redirect that crosses origins**, so your API key is never sent
to a host other than the one you targeted. Same-origin redirects keep it.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
dip --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line). List
endpoints are cursor-paginated: pass the returned `cursor` back via `--cursor`.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://search.dip.bundestag.de`) |
| `--api-key <key>` | DIP API key (env `DIP_API_KEY`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |
| `-o, --output <file>` | Write output to this file instead of stdout |

Global options go **before** the command, e.g. `dip --api-key $DIP_API_KEY vorgang list`.

### Commands

```text
<resource> list [--cursor <c>] [--id <id> ...] [--filter key=value ...]
<resource> get <id>

resources: vorgang | vorgangsposition | drucksache | drucksache-text
           plenarprotokoll | plenarprotokoll-text | aktivitaet | person
```

`--filter` passes a raw DIP filter (e.g. `f.titel=Klima`, `f.datum.start=2024-01-01`);
values may themselves contain `=` (only the first `=` splits key from value).
`--id` is shorthand for the repeatable `f.id` filter; if you pass both `--id` and
`--filter f.id=...`, the values are **merged** into a single `f.id` list (neither
silently wins).

`DIP_API_KEY` is read from the environment (trimmed; a blank value is treated as
unset). Precedence is `--api-key` > `DIP_API_KEY` > the (expired) bundled default.

### Examples

```bash
export DIP_API_KEY=your-personal-key

# Procedures matching a title
dip vorgang list --filter f.titel=Klimaschutz

# One printed paper by id
dip drucksache get 123456

# Next page using a cursor from a previous response
dip vorgang list --cursor "AoIIP4AAACg..."

# Members named in an activity filter
dip person list --filter f.titel=Mustermann
```

Exit codes: `0` success, `2` for usage errors (bad/missing arguments, unknown options), `4` on a `404` from the API, `1` for any other runtime error (incl. `401` when the key is missing/expired).

---

## Library usage

```ts
import { DipClient, DipApiError } from "dip-bundestag-cli";

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

---

## Architecture

```
src/
  client/
    types.ts     # ListResult (cursor envelope); documents as JsonObject
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, default headers (auth), decoding, errors
    errors.ts    # DipError / DipApiError / DipNetworkError / DipParseError
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

- The engine accepts `defaultHeaders` merged into every request — the seam used to inject
  `Authorization: ApiKey <key>`. The CLI surfaces it as `--api-key` (or `DIP_API_KEY`).
- The eight resources share one generic `ResourceGroup`, so adding a resource is a one-line change.
- The HTTP layer is a single `Transport` function; the default uses `node:http`/`node:https` and tests inject a mock.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — the Authorization header, per-resource paths and cursor/filter params — mocked transport.
- **`cli.test.ts`** — command parsing, `--api-key`/`--filter`/`--id`, and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
