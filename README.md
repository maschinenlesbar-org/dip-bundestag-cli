# dip-bundestag-cli

[![CI](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/dip-bundestag-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/dip-bundestag-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/dip-bundestag-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/dip-bundestag-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/dip-bundestag-cli/de/) — command reference, guides and API docs

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
  `--cursor`, with the same `--filter`s, to walk large result sets (DIP does not keep
  the filters in the cursor, so a `--cursor` without any filter is a usage error).
- **Flexible filtering** — pass any of the resource's DIP `f.*` filters via
  `--filter key=value`; `--id` is shorthand for the repeatable `f.id` filter.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/dip-bundestag-cli
```

This installs the **`dip`** command. Requires **Node.js 22.12+**.

Check it works:

```bash
dip --help
```

## API key

**DIP requires an API key** — it is not bundled. The Bundestag publishes a public
key on its [DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api) (stated
there in 2026 as valid until the end of May 2027; check the page for the current key);
you can also request a personal key free of charge from
`parlamentsdokumentation@bundestag.de`. Export either one:

```bash
export DIP_API_KEY=your-key
```

See **[Obtain key](#obtain-key)** for having the CLI fetch and check one for you.

The `DIP_API_KEY` environment variable is the **recommended, more secure** way to
supply the key. The `--api-key` flag also works but puts the secret on the process
command line, where it is visible to other local users via `ps` and may be
recorded in your shell history; prefer the env var, especially on shared hosts:

```bash
dip --api-key your-personal-key vorgang list
```

(`--api-key` is a global option, so it works **before or after** the command.)

**Or store it once**, in a credentials file of its own (the same mechanism as
[openka-cli](https://github.com/maschinenlesbar-org/openka-cli)'s `ka config`):

```bash
dip config set api-key                        # typed at a prompt, without echo
dip obtain-key | dip config set api-key       # or the published key, piped in
dip config get api-key                        # masked: R2bz…QyNa (--reveal prints it whole)
dip config list                               # what is stored, and where
dip config unset api-key
```

The value is never taken from the command line, so it reaches neither shell history
nor `ps`. The file is `$XDG_CONFIG_HOME/dip-bundestag/credentials` (else
`~/.config/dip-bundestag/credentials`): mode 0600 in a directory of mode 0700, replaced
atomically, and not read at all while anyone else could read it. It is consulted only
when neither `--api-key` nor `DIP_API_KEY` gives a key. A value edited into the file by
hand that `config set` would refuse (blank, a line break, an escape sequence) is refused
when it is read, naming the file (exit `1`). `dip config` prints to stdout
only: `-o` is refused (redirect stdout instead), so a key never lands on the terminal
when a file was asked for.

Precedence is `--api-key` > `DIP_API_KEY` env var > the credentials file > none. A blank `--api-key ""` is
a usage error (exit `2`), not a way to unset the env var; a blank `DIP_API_KEY` counts
as unset. **No key is bundled**:
when neither is supplied the `Authorization` header is omitted entirely and the
API returns `401`. On a `401` the CLI prints a plain-language hint with the
address to request a key.

## Obtain key

`dip obtain-key` reads the key the Bundestag publishes on its
[DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api) and then **proves
it still works** against the live API before printing it:

```bash
dip obtain-key               # -> the key, or a clear failure  (notes on stderr)
```

The help page is a JS app with nothing in its served HTML, but the prose it renders
comes from DIP's own content service as plain JSON, so the key is read from there —
`content.dip.bundestag.de/content-api/v1/content/help-api`. If that document is
unreachable or its key is rejected, the upstream
[bundesAPI/dip-bundestag-api](https://github.com/bundesAPI/dip-bundestag-api)
README is tried as a fallback. Every request `obtain-key` makes goes through the
same request engine as the other commands — `--timeout` (default 30 s),
`--max-response-bytes` (default 100 MiB), `--max-retries` for a 429/503, and
redirect following — so a stalled host fails the command instead of hanging it, and
a passing 503 does not.
The key only ever goes to stdout: `-o` is refused (redirect stdout instead), and with
`--base-url` the check runs against that host, which the stderr note then names
instead of "the live API".

That verification is the point. DIP rotates its published key (the one in place in
2026 is stated as valid until the end of May 2027), and a command that printed a
rejected key anyway would hand you something that cannot authenticate. So when no
published key is accepted, `obtain-key` fails instead and names the two places a
working key comes from — the help page, or a free personal key from
`parlamentsdokumentation@bundestag.de`. A key counts as verified only when the
host that received it answers with a DIP list: an answer from another origin (after
a redirect, which withholds the key) or a 200 that is an error object or an HTML
page (a captive portal, a proxy) ends in "Could not verify", exit `1`. So does a
`403` (a WAF or a geo block refusing the request, not a verdict on the key), which
the message names as such; only a `401` counts as the key being rejected.

**From obtaining the key to having it where it is used, in one line:**

```bash
# this shell only
key=$(dip obtain-key) && export DIP_API_KEY="$key"

# or keep it for later — appends one `export …` line to your shell profile
dip obtain-key --export >> ~/.zshrc     # ~/.bashrc on bash
```

The `&&` matters: when no key can be obtained, nothing is exported and the line
exits with `obtain-key`'s non-zero code, in sh, bash and zsh alike. The tempting
`eval "$(dip obtain-key --export)"` fails quietly instead — `eval` of an empty string
exits `0`. In a script, stop on the failure: `key=$(dip obtain-key) || exit`.

Once you have a key from the help page or by email, the same one-liner shape
works without the network round-trip:

```bash
export DIP_API_KEY=your-key
```

`--no-verify` skips the live check and prints the published candidate with a loud
warning — useful offline, but expect a `401` if the source has drifted.

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
**[Glossary](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/GLOSSARY.md)** decodes every one.

### `list` options

| Option | Meaning |
| --- | --- |
| `--cursor <cursor>` | Pagination cursor from a previous page. Repeat that page's `--filter`/`--id` with it: DIP does not keep them in the cursor, and a cursor alone would page through the whole unfiltered list, so `--cursor` without any `--filter` or `--id` is a usage error (exit `2`) |
| `--id <id>` | Filter by id, a whole number — repeatable; maps to `f.id` |
| `--filter <key=value>` | DIP filter, e.g. `f.titel=Klima` — repeatable; the key must be one of the resource's `f.*` filters |

`--filter` passes the key and value verbatim to DIP. The key must be one of the
`f.*` filters DIP documents for that resource (the error lists them): DIP ignores
a key it does not know and answers with the whole unfiltered list, so a typo such
as `f.titl`, or `f.person` on `vorgang`, is a usage error (exit `2`) instead. Only the first `=` splits
key from value, so a value may itself contain `=`. Repeating the same key sends
repeated query parameters, which DIP treats as an OR set. `--id` and
`--filter f.id=…` are merged (neither silently wins). The integer filters — `f.id`, `f.wahlperiode`, `f.vorgang`, `f.drucksache`, `f.plenarprotokoll`, `f.aktivitaet`, `f.person_id`, `f.vorgangsposition_id` and `f.vorgangstyp_notation` —
take a non-negative whole number in plain digits; anything else (`abc`, `1e3`, `-1`,
a value with spaces) is a usage error (exit `2`), because DIP answers it with a misleading
`400 … Invalid cursor` or with 0 hits.

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
| `f.person=<name>` | Person surname (on `person` and `aktivitaet` only) |

## Common tasks

A few recipes to get going — see **[Usage.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/Usage.md)** for the full,
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
dip person get 14          # an id from the list above (14 = Angela Merkel)

# Plenary protocol transcript to a file
dip plenarprotokoll-text get 5678 | jq -r '.text' > protokoll.txt

# Activities updated since a date (full ISO datetime required)
dip --output aktivitaeten.json aktivitaet list \
  --filter f.aktualisiert.start=2024-05-01T00:00:00 --filter f.wahlperiode=20
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`dip.cli` for usage
errors, `dip.api` for the API's answers, `dip.http` for the connection, `dip.config`,
`dip.obtain-key`, `dip.output`). By default it is written log4j style; `--log-format
jsonl` writes one JSON object per line instead:

```text
2026-10-09T14:03:12.481Z WARN  [dip.http] requests to mirror.test are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [dip.api] HTTP 404 for GET https://search.dip.bundestag.de/api/v1/vorgang/1: Not found
```

```bash
dip --log-format jsonl vorgang get 1 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"dip.api","msg":"HTTP 404 …"}
```

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

`-o` **will not overwrite an existing file** — it exits with an error
(`Refusing to overwrite existing file …; pass --force to overwrite.`) to protect
against a mistyped path clobbering your data. Pass `--force` to overwrite
deliberately. A directory is refused either way, and `-o -` prints to stdout.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version` / `help [command…]`) |
| `2` | Bad usage / invalid argument (nothing was sent) — an unknown command too, also via `help` (`dip help nope` says `error: unknown command 'nope'`, as `dip nope` does) |
| `4` | Document not found (`404` from the API) |
| `1` | Any other runtime error — including `401` (missing/expired key) and network failures |

## Troubleshooting

- **`command not found: dip`** — the global npm bin directory isn't on your
  `PATH`. Run `npm prefix -g` and add its `bin/` subdirectory (on Windows, the
  directory itself), or run via
  `npx @maschinenlesbar.org/dip-bundestag-cli …`.
- **Exit `1` / HTTP 401 "… use an https base URL"** — `--base-url` starts with
  `http://`; DIP redirects to `https://`, and the key is not sent across that change
  of scheme. Use the `https://` URL.
- **Exit `1` / "Authentication failed (401)"** — no key was sent, or the key
  is not (or no longer) valid. Try `dip obtain-key` (it checks a key before
  printing it), or export `DIP_API_KEY` / pass `--api-key` with the
  current public key from the
  [DIP API help page](https://dip.bundestag.de/über-dip/hilfe/api), or request a
  personal key from `parlamentsdokumentation@bundestag.de`.
- **Exit `4` / "not found"** — the id passed to `get` doesn't exist. Re-fetch
  it from a fresh `list` result; ids can change as the catalogue updates.
- **Exit `1` / rate-limited** — DIP answered `429`; the client retries
  `429`/`503` automatically up to `--max-retries` times, honouring the server's
  `Retry-After` up to 30 s. If the error persists,
  slow down and try again later.
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
| `--api-key <key>` | DIP API key (env `DIP_API_KEY`). Surrounding whitespace is trimmed, as for `DIP_API_KEY`. A blank value, control characters or characters above U+00FF are a usage error (exit `2`), from the flag or the env var; the error never repeats the key |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [dip.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-o, --output <file>` | Write output to this file instead of stdout (refuses to overwrite an existing file; `-` = stdout; a blank path is a usage error, exit `2`) |
| `--force` | With `-o`, overwrite the output file if it already exists |
| `--base-url <url>` | API base URL: the host, **without** `/api/v1`, which the CLI adds (default `https://search.dip.bundestag.de`). `http:`/`https:` only; a query (`?`), fragment (`#`), whitespace (surrounding or inside), a trailing `/api/v1` or a `%` in the user name or password that is not an escape (write a literal `%` as `%25`) is a usage error (exit `2`). A `user:password@` part is sent as HTTP Basic auth (unless an API key takes the `Authorization` header) but shown as `***@` in everything the CLI prints, usage errors included. Credentials go to this origin only: a redirect to another host, port or scheme (http→https included) drops them, so use `https://`. A plain-`http:` base URL to any host other than the loopback interface (`localhost`, `127.0.0.0/8`, `::1`) logs one WARN record of `dip.http` on stderr before the first request (naming the host and whether the API key or the URL's credentials go with it, never their values); stdout and the exit code are unchanged |
| `--timeout <ms>` | Time limit per request, reading the whole response included (default `30000`; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value. A blank value, control characters or characters above U+00FF are a usage error (exit `2`) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`). Each retry backs off linearly from 200 ms, or waits the server's `Retry-After` when that is longer (never shorter, so `Retry-After: 0` causes no burst). A `Retry-After` over 30 s is not retried; the error names the requested wait |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI.
- **[Usage.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/GLOSSARY.md)** — every domain term and filter explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

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
