# dip-bundestag-cli

[![CI](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/dip-bundestag-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/dip-bundestag-cli)

Browse Germany's **Bundestag parliamentary record** from your terminal. `dip` is
a command-line tool over the
[Bundestag DIP API](https://dip.bundestag.de/über-dip/hilfe/api)
(`search.dip.bundestag.de/api/v1`): search procedures, printed papers, plenary
protocols, activities and people — as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **All eight DIP resources in one command** — Vorgänge, Drucksachen,
  Plenarprotokolle and more, each with `list` and `get`.
- **Clean JSON output** — pretty-printed by default, `--compact` for
  one-line/scripting, `-o <file>` to write directly to disk.
- **Cursor pagination built in** — pass the returned `cursor` back via
  `--cursor` to walk large result sets.
- **Flexible filtering** — pass any DIP `f.*` filter verbatim via
  `--filter key=value`; `--id` is shorthand for the repeatable `f.id` filter.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/dip-bundestag-cli
```

This installs the **`dip`** command. Requires **Node.js 20+**.

Check it works:

```bash
dip --help
```

## API key

**DIP requires an API key** — it is not bundled. Request a personal key free of
charge from `parlamentsdokumentation@bundestag.de`, then export it:

```bash
export DIP_API_KEY=your-personal-key
```

The `DIP_API_KEY` environment variable is the **recommended, more secure** way to
supply the key. The `--api-key` flag also works but puts the secret on the process
command line, where it is visible to other local users via `ps` and may be
recorded in your shell history; prefer the env var, especially on shared hosts:

```bash
dip --api-key your-personal-key vorgang list
```

(`--api-key` is a global option, so it works **before or after** the command.)

Precedence is `--api-key` > `DIP_API_KEY` env var > none. **No key is bundled**:
when neither is supplied the `Authorization` header is omitted entirely and the
API returns `401`. On a `401` the CLI prints a plain-language hint with the
address to request a key.

## Quickstart

```bash
export DIP_API_KEY=your-personal-key

# Procedures matching a title keyword
dip vorgang list --filter f.titel=Klimaschutz

# How many matched?
dip vorgang list --filter f.titel=Klimaschutz | jq '.numFound'

# Fetch one procedure by id
dip vorgang get 282486

# Full text of a printed paper
dip drucksache-text list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=20 \
  | jq -r '.documents[0].text'
```

## Commands

Every resource follows the same two-subcommand pattern:

```text
<resource> list [--cursor <c>] [--id <id> …] [--filter key=value …]
<resource> get  <id>
```

| Resource | What it is |
| --- | --- |
| `vorgang` | Procedure / legislative process |
| `vorgangsposition` | Step within a procedure |
| `drucksache` | Printed paper (metadata only) |
| `drucksache-text` | Printed paper with extracted full text |
| `plenarprotokoll` | Plenary protocol (metadata only) |
| `plenarprotokoll-text` | Plenary protocol with extracted full text |
| `aktivitaet` | Activity — links a person to a procedure |
| `person` | Person (member / actor) |

New to terms like *Vorgang*, *Drucksache*, *Wahlperiode* or *Vorgangstyp*? The
**[Glossary](GLOSSARY.md)** decodes every one.

### `list` options

| Option | Meaning |
| --- | --- |
| `--cursor <cursor>` | Pagination cursor from a previous page |
| `--id <id>` | Filter by id — repeatable; maps to `f.id` |
| `--filter <key=value>` | Raw DIP filter, e.g. `f.titel=Klima` — repeatable |

`--filter` passes the key and value verbatim to DIP. Only the first `=` splits
key from value, so a value may itself contain `=`. Repeating the same key sends
repeated query parameters, which DIP treats as an OR set. `--id` and
`--filter f.id=…` are merged (neither silently wins).

### Common DIP filters

| Filter | Meaning |
| --- | --- |
| `f.titel=<text>` | Title keyword |
| `f.id=<n>` | Specific document id |
| `f.wahlperiode=<n>` | Electoral term (e.g. `20`) |
| `f.datum.start=<YYYY-MM-DD>` | Date range start |
| `f.datum.end=<YYYY-MM-DD>` | Date range end |
| `f.aktualisiert.start=<YYYY-MM-DDThh:mm:ss>` | Last-updated range start (full ISO datetime) |
| `f.aktualisiert.end=<YYYY-MM-DDThh:mm:ss>` | Last-updated range end |
| `f.vorgangstyp=<type>` | Procedure type (e.g. `Gesetzgebung`) |
| `f.dokumentart=<type>` | Document type |
| `f.zuordnung=BT\|BR` | Chamber — Bundestag (`BT`) or Bundesrat (`BR`) |
| `f.person=<name>` | Person surname (for the `person` resource) |

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Procedures by date range
dip vorgang list \
  --filter f.datum.start=2024-01-01 \
  --filter f.datum.end=2024-03-31

# Drucksachen for one electoral term, Bundestag only
dip drucksache list --filter f.wahlperiode=20 --filter f.zuordnung=BT

# Look up a person, then fetch their full record
dip person list --filter f.person=Merkel \
  | jq -r '.documents[] | "\(.id)\t\(.titel)"'
dip person get 7240

# Plenary protocol transcript to a file
dip plenarprotokoll-text get 5678 | jq -r '.text' > protokoll.txt

# Activities updated since a date (full ISO datetime required)
dip --output aktivitaeten.json aktivitaet list \
  --filter f.aktualisiert.start=2024-05-01T00:00:00 --filter f.wahlperiode=20
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# Total result count for a query
dip vorgang list --filter f.titel=Klimaschutz | jq '.numFound'

# Extract titles from the current page
dip drucksache list --filter f.titel=Klimaschutz \
  | jq -r '.documents[].titel'

# Cursor pagination — walk page by page
CURSOR=$(dip vorgang list --filter f.wahlperiode=20 | jq -r '.cursor')
dip vorgang list --filter f.wahlperiode=20 --cursor "$CURSOR"

# Fetch several documents by id in one call
dip drucksache list --id 123456 --id 123457 --id 123458 \
  | jq -r '.documents[] | "\(.id)\t\(.titel)"'
```

Use `--compact` for single-line JSON. Note that `--compact` is a **global
option** — it works **before or after** the command:

```bash
dip --compact vorgang list --filter f.titel=Klimaschutz | jq -c '.documents[]'
```

Use `-o <file>` to write output to a file instead of stdout (also a global
option — works before or after the command):

```bash
dip --output results.json drucksache list --filter f.titel=Bürgergeld
```

`-o` **will not overwrite an existing file** — it exits with an error to protect
against a mistyped path clobbering your data. Pass `--force` to overwrite
deliberately.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Document not found (`404` from the API) |
| `1` | Any other runtime error — including `401` (missing/expired key) and network failures |

## Troubleshooting

- **`command not found: dip`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/dip-bundestag-cli …`.
- **Exit `1` / "Authentication failed (401)"** — no key was sent, or the key
  has expired. Export `DIP_API_KEY` or pass `--api-key`. Request a personal key
  from `parlamentsdokumentation@bundestag.de`.
- **Exit `4` / "not found"** — the id passed to `get` doesn't exist. Re-fetch
  it from a fresh `list` result; ids can change as the catalogue updates.
- **Exit `1` / rate-limited** — the shared key (if used) is rate-limited;
  the client retries `429`/`503` automatically up to `--max-retries` times. If
  the error persists, use a personal key or increase `--timeout`.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again or
  raise the limit with `--timeout 60000`.
- **Empty `documents` array** — the query matched nothing; try a broader
  keyword, remove filters, or check the `numFound` field.
- **`400 Invalid date-time`** — `f.aktualisiert.start` / `f.aktualisiert.end`
  require a full ISO datetime (`YYYY-MM-DDThh:mm:ss`), not a bare date. Use
  `f.datum.start` / `f.datum.end` for plain `YYYY-MM-DD` dates.

## Global options

These may be given **before or after** the command, e.g.
`dip --api-key $DIP_API_KEY vorgang list`:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--api-key <key>` | DIP API key (env `DIP_API_KEY`) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout (refuses to overwrite an existing file) |
| `--force` | With `-o`, overwrite the output file if it already exists |
| `--base-url <url>` | API base URL (default `https://search.dip.bundestag.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term and filter explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Deutscher Bundestag** — custom DIP Nutzungsbedingungen. Attribution required
> ("Quelle: Deutscher Bundestag – DIP"); broad reuse incl. commercial use allowed
> (with a note that the data is free of charge in DIP).

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
