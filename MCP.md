# dip-bundestag-mcp

An [MCP](https://modelcontextprotocol.io/) server for
[DIP](https://dip.bundestag.de/), the Bundestag's documentation and information system for
parliamentary materials: legislative procedures end to end (every step in Bundestag and Bundesrat,
the votes, the committees), dossiers on members and other persons, and the full text of
Drucksachen and Plenarprotokolle, as tools for AI agents. Read-only. The API needs a key; the
server finds the Bundestag's public one by itself (see API key). The data is the Bundestag's under
its own terms (see Licence).

It is the MCP side of [dip-bundestag-cli](https://github.com/maschinenlesbar-org/dip-bundestag-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/dip-bundestag-mcp
```

This installs the **`dip-mcp`** command (Node.js 22.12+). Or run the container image, for
linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/dip-bundestag-mcp:latest
```

## API key

DIP wants `Authorization: ApiKey …`. The Bundestag publishes a public key on its
[API help page](https://dip.bundestag.de/%C3%BCber-dip/hilfe/api) and renews it now and then; a
personal key is available from parlamentsdokumentation@bundestag.de. **No key is bundled.** The
server takes it, at the first tool call, from:

1. `DIP_API_KEY` in its environment (what an MCP client's config sets);
2. else the key stored with `dip config set api-key` (the CLI's credentials file,
   `$XDG_CONFIG_HOME/dip-bundestag/credentials`, else `~/.config/dip-bundestag/credentials`; a file
   others can read is refused, naming the fix);
3. else it obtains the published key from the document behind the help page and **verifies it
   against the live API** before using it, as `dip obtain-key` does (the machine-readable sources
   have lagged behind the current key), so a renewed key needs no new release.

One INFO record on stderr says which, never the key. The key is replaced with `***` in every log
record, result and error (a key shorter than 16 characters only where it stands whole, not inside a
longer word of the data). The server takes no key on its command line. A lookup that fails (the
source unreachable, no published key accepted) is that call's error, and the next call tries again.
When DIP refuses the key (HTTP 401), the error says what to do for where the key came from: a
public key the server obtained was renewed, and a restart obtains the current one; a key from
DIP_API_KEY or the credentials file is read again at a restart, so replace it (`dip obtain-key`
prints the current one) or remove it so that the server obtains the public key. In a container without network access to content.dip.bundestag.de, pass the
key: `docker run -i --rm -e DIP_API_KEY ghcr.io/…`.

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add dip -- dip-mcp
# or with the image:
claude mcp add dip -- docker run -i --rm ghcr.io/maschinenlesbar-org/dip-bundestag-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "dip": { "command": "dip-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "dip": { "type": "stdio", "command": "dip-mcp" } } }
```

To set the key yourself, add `"env": { "DIP_API_KEY": "…" }` to the entry (the value
`dip obtain-key` prints, or your personal key).

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
dip-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http dip http://127.0.0.1:3000/mcp
```

The public key is public, so HTTP needs no authentication for it; a personal key set in
`DIP_API_KEY` would be used for every caller, so keep such a server to yourself. In a container,
publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/dip-bundestag-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/dip-bundestag-cli/releases) instead of
`latest`: `…/dip-bundestag-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/dip-bundestag-mcp:<version> --repo maschinenlesbar-org/dip-bundestag-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `trackProcedure` | A procedure (Vorgang) by id or title words: where it stands, every step oldest first with chamber and document, the decisions named for what they are, the votes on the bill, the lead committees, and whether it is promulgated. A long timeline the size cap cuts says `nextOffset`: `offset` reads on to the newest steps (the votes and committees are always those of every step). |
| `profileMember` | A member of the Bundestag or another person by id or name: current function, Fraktion, ministry, terms, earlier roles, and on request the activities (speeches, questions, papers) of a term. |
| `readDocument` | A Drucksache or Plenarprotokoll by id, number or title words: its metadata with the citation and PDF, and its full text in passages, or only the passages that hold a word. |
| `searchRecords` | The records of one resource (procedures, steps, Drucksachen, Plenarprotokolle, activities, persons) with DIP's own filters, newest first, paged. |
| `getRecord` | One record by resource and id, with all its fields. |

The tools carry DIP's traps so a model doesn't have to: the title filter matches whole words of
the title only (not the abstract, not word parts), and a law's popular name is often only in its
abstract, so a search that finds only questions says to retry with a word of the official title
and the type Gesetzgebung; several matches are reported with the candidates, laws first, never
picked; a procedure's steps are joined on the positions (`f.vorgang`), read page after page with
the same filter (a cursor alone would page through every procedure's steps) and sorted by date;
not every decision is a vote: a referral, a procedural motion, a Bundesrat opinion or a resolution
is named as such, and "passed" comes only from an adoption in the 2./3. Beratung (or of the
mediation committee's proposal, the version that becomes law) or from promulgation; names match only as complete first or last names, so the surname is sent and a
name DIP misses is looked up in the term's whole list; a Fraktion is given only for members
(MdB), and earlier roles carry the ministry, not the role's title; a document is found on the
light metadata endpoint and only then read from the heavy text endpoint; a Plenarprotokoll is the
whole sitting, so `find` picks the passages of an agenda item or a speaker; the text is the PDF's
extraction and comes verbatim; `f.aktualisiert` wants a date and time and `f.datum` a date, and
each is sent in that form; an unknown filter, which DIP would ignore and answer everything, is
refused.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (whole, never cut like the data; an answer a redirect fetched from another
host says so there: "… (answered by https://other.example after a redirect)", and a WARN record
names both) and the data licence. A text over 2000 characters is cut and ends in `…[cut, N
characters in all]`, and the answer says `truncated`. An answer over `--max-result-chars` first
loses entries from the end of its page (then `nextOffset` says where to go on), then has its longest
texts cut further (each with that mark) or, when that isn't enough, its other lists shortened
(`reason` names them); a list keeps its first entry, `notes` stay whole, and the answer says
`truncated`. One that can't be cut down so far is a tool error that says to ask for less. A failure
is a tool error that says what to change (one over 5000 characters loses its middle, never its end,
where the reason is).

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API host (default https://search.dip.bundestag.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses the requests to a host that answers HTTP 429 (as long as its Retry-After
  asks, at most 30 s; those to another host go on), and stops a tool call after its deadline (a tool
  that has read part of its answer by then may answer with that part, and says so). DIP's terms warn
  that overloading the API can get a key blocked. `trackProcedure` makes two requests for an id (a
  title search one more, a long history one more per 100 steps), `profileMember` one or two (a surname of more than
  100 people one per 100 of them, a name DIP misses, with a term: one per 100 people of the term,
  each at most `--max-pages`; an answer after a partial read says how many were compared), `readDocument`
  one or two, `searchRecords` one per 100 records up to the page asked for (`offset` + `limit` at most
  `--max-pages` × 100: at that limit there is no `nextOffset`, and the note says to narrow the filters), `getRecord` one; the
  first call also reads the key's source and verifies the key once when no key is set. A request
  those limits would hold longer than it or its call may wait is not sent: the call fails at once,
  naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; the API key echoed with
  one inside is still replaced; a key that cleaning makes equal to another stays, as `name~2`), but
  it is still text from outside: a model can be told things in it. The server can't act on that (it
  has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/LICENSING.md)).
Data: the Deutscher Bundestag's, served live, under its own terms, the "Nutzungsbedingungen für
DIP" (27.02.2023), not an open licence: the API data may be reused and processed with the source
("Quelle: Deutscher Bundestag – DIP (dip.bundestag.de)") and your changes marked; quoted documents
are cited by type and number (BT-Drs. 20/6875, BT-PlPr. 20/120) and left unaltered; commercial use
adds that the data is available free of charge in DIP; no distorting or defamatory use
([terms](https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/dip-bundestag-cli/blob/main/DATA_LICENSE.md)).
Every result carries this note in its `licence` field. We provide the tool, not the data: running
the server as a service for others may need the Bundestag's permission.
