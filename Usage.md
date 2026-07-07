# Usage

Practical, use-case-driven examples for the `dip` CLI — a command-line client for
the Bundestag **DIP API** (`search.dip.bundestag.de`), covering Vorgänge,
Drucksachen, Plenarprotokolle, Aktivitäten and Personen of the German Bundestag
and Bundesrat. Every command prints JSON to stdout, so the examples below pipe
into [`jq`](https://jqlang.github.io/jq/) where it helps.

## Install

```bash
npm i -g @maschinenlesbar.org/dip-bundestag-cli
```

This installs the **`dip`** binary. Without a global install you can run the same
commands via `node dist/src/cli/index.js …` after `npm run build`.

## Authentication

DIP requires an API key, sent as `Authorization: ApiKey <key>`. Supply it either
way:

```bash
# As an environment variable (recommended)
export DIP_API_KEY=your-personal-key
dip vorgang list

# Or per-invocation (note: a global option, so it goes BEFORE the command)
dip --api-key your-personal-key vorgang list
```

Precedence is `--api-key` > `DIP_API_KEY` > none. **No key is bundled** — when
neither is supplied the `Authorization` header is omitted and requests return
`401`. Request a personal key from `parlamentsdokumentation@bundestag.de`.

## Use cases

The examples assume `DIP_API_KEY` is exported. Filters are passed verbatim to DIP
via `--filter <key=value>` (repeatable); `--id` is shorthand for the repeatable
`f.id` filter.

### Search Drucksachen by title

Find printed papers whose title matches a keyword.

```bash
dip drucksache list --filter f.titel=Klimaschutz
```

The response is a cursor-paginated envelope with `numFound`, `documents` and a
`cursor`. To list just the titles:

```bash
dip drucksache list --filter f.titel=Klimaschutz \
  | jq -r '.documents[].titel'
```

### Filter Drucksachen by Wahlperiode

Scope a search to a single electoral term (e.g. the 20th Wahlperiode).

```bash
dip drucksache list --filter f.titel=Bürgergeld --filter f.wahlperiode=20
```

Multiple `--filter` flags are combined into one query. Add `--compact` if you
want each result on a single line for easier downstream processing.

### Browse Vorgänge by date range

Procedures dated within a given window, using DIP's date-range filter keys.

```bash
dip vorgang list \
  --filter f.datum.start=2024-01-01 \
  --filter f.datum.end=2024-03-31
```

Dates are ISO `YYYY-MM-DD`. Count how many matched without scrolling the JSON:

```bash
dip vorgang list --filter f.datum.start=2024-01-01 --filter f.datum.end=2024-03-31 \
  | jq '.numFound'
```

### Filter Vorgänge by procedure type

Narrow procedures to a specific Vorgangstyp (e.g. a Gesetzgebung procedure).

```bash
dip vorgang list \
  --filter f.vorgangstyp=Gesetzgebung \
  --filter f.wahlperiode=20
```

### Inspect a single Vorgang and its positions

Look up one procedure by id, then list the Vorgangspositionen attached to it.

```bash
# The procedure itself
dip vorgang get 282486

# Its positions (Vorgangspositionen) for the same procedure
dip vorgangsposition list --filter f.vorgang=282486 \
  | jq -r '.documents[].vorgangsposition'
```

`get <id>` takes the id as a positional argument and returns the full document.

### Pull a Drucksache with full text

Retrieve printed papers including their extracted body text, then read the text
of the first hit.

```bash
dip drucksache-text list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=20 \
  | jq -r '.documents[0].text'
```

Use `drucksache` for metadata only, `drucksache-text` when you need the document
body. The same `<resource>` / `<resource>-text` split applies to Plenarprotokolle.

### Search Plenarprotokolle and grab a full transcript

Find plenary protocols, then fetch one complete transcript by id.

```bash
# List protocols for a term
dip plenarprotokoll list --filter f.wahlperiode=20 \
  | jq -r '.documents[] | "\(.id)\t\(.dokumentnummer)\t\(.datum)"'

# Fetch the full text of one protocol
dip plenarprotokoll-text get 5678 | jq -r '.text' > protokoll.txt
```

### Filter materials by chamber (Bundestag vs Bundesrat)

Restrict results to Bundestag (`BT`) or Bundesrat (`BR`) materials via the
Zuordnung filter.

```bash
dip drucksache list --filter f.wahlperiode=20 --filter f.zuordnung=BT
```

### Look up a Person (member)

Find members by name, then fetch one full record by id.

```bash
# Search by surname
dip person list --filter f.person=Merkel \
  | jq -r '.documents[] | "\(.id)\t\(.titel)"'

# Fetch one person record
dip person get 7240
```

Use the `f.person` filter for member names (`f.titel` is not a valid key for the
person endpoint and is silently ignored).

### List recent Aktivitäten and save them to a file

Activities updated since a given date, written to disk instead of stdout.

```bash
dip --output aktivitaeten.json aktivitaet list \
  --filter f.aktualisiert.start=2024-05-01T00:00:00 --filter f.wahlperiode=20
```

The `f.aktualisiert.start` / `f.aktualisiert.end` filters expect a full ISO
date-time (`YYYY-MM-DDThh:mm:ss`); a bare date is rejected with `400 Invalid
date-time`. (The `f.datum.start` / `f.datum.end` filters used above accept a
plain `YYYY-MM-DD` date.)

`-o, --output <file>` is a global option (place it before the command). It is
also how you save binary downloads.

### Paginate through a large result set

List endpoints are cursor-paginated: pass the `cursor` from one page back via
`--cursor` to get the next.

```bash
# First page — capture the cursor
CURSOR=$(dip vorgang list --filter f.wahlperiode=20 | jq -r '.cursor')

# Next page
dip vorgang list --filter f.wahlperiode=20 --cursor "$CURSOR"
```

### Fetch several documents by id at once

`--id` is repeatable and maps to DIP's `f.id` OR-set, so one call can fetch
multiple records.

```bash
dip drucksache list --id 123456 --id 123457 --id 123458 \
  | jq -r '.documents[] | "\(.id)\t\(.titel)"'
```

## Global options

Global options go **before** the command (e.g. `dip --api-key … vorgang list`):

| Option | Description |
| --- | --- |
| `-V, --version` | Print the CLI version |
| `--base-url <url>` | API base URL (default `https://search.dip.bundestag.de`) |
| `--api-key <key>` | DIP API key (env `DIP_API_KEY`) |
| `--timeout <ms>` | Per-request timeout in milliseconds |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `-h, --help` | Show help (also available per command, e.g. `dip vorgang list --help`) |

**Commands:** `vorgang`, `vorgangsposition`, `drucksache`, `drucksache-text`,
`plenarprotokoll`, `plenarprotokoll-text`, `aktivitaet`, `person` — each with
`list [--cursor <c>] [--id <id> …] [--filter key=value …]` and `get <id>`.
