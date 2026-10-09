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

# Or the published key, checked before it is exported (nothing is exported, and the
# line exits non-zero, when no key can be obtained)
key=$(dip obtain-key) && export DIP_API_KEY="$key"

# Or per-invocation (a global option: it works before or after the command)
dip --api-key your-personal-key vorgang list

# Or stored once in a credentials file (typed without echo, or piped in)
dip config set api-key
dip obtain-key | dip config set api-key
```

Precedence is `--api-key` > `DIP_API_KEY` > the credentials file > none. `dip config`
keeps the key in `$XDG_CONFIG_HOME/dip-bundestag/credentials` (else
`~/.config/dip-bundestag/credentials`), mode 0600, written atomically; `config set` reads
the value from a prompt without echo or from stdin, never from the command line;
`config get` shows it masked (`--reveal` prints it whole); `config list` and `config
unset` do what they say. A file that others can read is refused, and only when it is
needed; a blank `--api-key ""` is a usage
error (exit `2`). **No key is bundled** — when
neither is supplied the `Authorization` header is omitted and requests return
`401`. The Bundestag publishes a public key on its
[DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api) (stated there in
2026 as valid until the end of May 2027); a personal key can be requested from
`parlamentsdokumentation@bundestag.de`.

## Use cases

The examples assume `DIP_API_KEY` is exported. Filters are passed verbatim to DIP
via `--filter <key=value>` (repeatable); `--id` is shorthand for the repeatable
`f.id` filter. The key must be one of the resource's `f.*` filters — DIP ignores
an unknown one and would return the whole unfiltered list, so the CLI rejects it
(exit `2`) and lists the valid ones. The integer filters (`f.id`, `f.wahlperiode`, `f.vorgang`, `f.drucksache`, `f.plenarprotokoll`, `f.aktivitaet`, `f.person_id`, `f.vorgangsposition_id` and `f.vorgangstyp_notation`,
and `--id`) take plain digits only; another value is a usage error (exit `2`) rather
than DIP's misleading `400 … Invalid cursor`.

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
Surrounding whitespace is trimmed (a copy-pasted `"282486 "` works); a blank id is a
usage error (exit `2`).

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

# Fetch one person record, by an id from the list above (14 = Angela Merkel)
dip person get 14
```

Use the `f.person` filter for member names (`f.titel` is not a filter of the
person endpoint; DIP would ignore it, so the CLI rejects it).

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

`-o, --output <file>` is a global option (before or after the command) and writes
the JSON output to a file. It **refuses to overwrite an existing file**
(exits with an error) so a mistyped path cannot clobber your data; add `--force`
to overwrite deliberately.

### Paginate through a large result set

List endpoints are cursor-paginated: pass the `cursor` from one page back via
`--cursor` to get the next — **with the same filters**. DIP does not bind a cursor to
the query it came from, so a cursor alone would page through the whole unfiltered list;
the CLI refuses a `--cursor` without any `--filter` or `--id` as a usage error (exit 2).

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

Global options work **before or after** the command (`dip --compact vorgang list`
and `dip vorgang list --compact` are the same):

| Option | Description |
| --- | --- |
| `-V, --version` | Print the CLI version |
| `--base-url <url>` | API base URL: the host, **without** `/api/v1`, which the CLI adds (default `https://search.dip.bundestag.de`). `http:`/`https:` only; a query (`?`), fragment (`#`), whitespace (surrounding or inside), a trailing `/api/v1` or a `%` in the user name or password that is not an escape (write a literal `%` as `%25`) is a usage error (exit `2`). A `user:password@` part is sent as HTTP Basic auth (unless an API key takes the `Authorization` header) but shown as `***@` in everything the CLI prints, usage errors included. Credentials go to this origin only: a redirect to another host, port or scheme (http→https included) drops them, so use `https://`. A plain-`http:` base URL to any host other than the loopback interface (`localhost`, `127.0.0.0/8`, `::1`) logs one WARN record of `dip.http` on stderr before the first request (naming the host and whether the API key or the URL's credentials go with it, never their values); stdout and the exit code are unchanged |
| `--api-key <key>` | DIP API key (env `DIP_API_KEY`). Surrounding whitespace is trimmed, as for `DIP_API_KEY`. A blank value, control characters or characters above U+00FF are a usage error (exit `2`), from the flag or the env var; the error never repeats the key |
| `--timeout <ms>` | Time limit per request in milliseconds, reading the whole response included (at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value. A blank value, control characters or characters above U+00FF are a usage error (exit `2`) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`); each backs off linearly from 200 ms, or waits the server's `Retry-After` when that is longer (never shorter). A `Retry-After` over 30 s is not retried; the error names the requested wait |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [dip.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-o, --output <file>` | Write output to this file instead of stdout (refuses to overwrite an existing file; `-` = stdout; a blank path is a usage error, exit `2`) |
| `--force` | With `-o`, overwrite the output file if it already exists |
| `-h, --help` | Show help (also available per command, e.g. `dip vorgang list --help`, or as `dip help vorgang list`; an unknown name there is the same usage error as `dip nope`: `error: unknown command 'nope'`, exit `2`) |

**Commands:** `vorgang`, `vorgangsposition`, `drucksache`, `drucksache-text`,
`plenarprotokoll`, `plenarprotokoll-text`, `aktivitaet`, `person` — each with
`list [--cursor <c>] [--id <id> …] [--filter key=value …]` and `get <id>`.
