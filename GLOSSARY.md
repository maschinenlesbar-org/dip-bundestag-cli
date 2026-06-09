# Glossary

A reference for the domain concepts and project-specific terms used throughout
`dip-bundestag-cli`. The DIP domain is German; this glossary gives the English
term used in the CLI/API (where one exists) alongside the original German.

> **Translation table.** The CLI keeps the original German resource names (they
> are the API's own paths), with the English meaning given here:
>
> | German | English |
> | --- | --- |
> | Vorgang | procedure / legislative process |
> | Vorgangsposition | procedure step / position within a procedure |
> | Drucksache | printed paper |
> | Plenarprotokoll | plenary protocol (minutes) |
> | Aktivität | activity |
> | Person | person (member / actor) |
> | Wahlperiode | electoral term / legislative period |
> | Bundestag | the federal parliament |
> | Bundesrat | the federal council (states' chamber) |

---

## DIP

**DIP — Dokumentations- und Informationssystem für Parlamentsmaterialien.**
("Documentation and information system for parliamentary materials.") The
Bundestag's catalogue of parliamentary process data: who proposed what, the
documents involved, the plenary debates, and the people acting. Browsable at
[`dip.bundestag.de`](https://dip.bundestag.de); the machine API this tool wraps
lives at `search.dip.bundestag.de/api/v1`.

**Bundestag.** The German federal parliament (the elected chamber). **Bundesrat**
is the chamber representing the sixteen federal states (Länder). DIP covers
materials from both bodies.

**API key.** DIP requires an API key, sent as the HTTP header
`Authorization: ApiKey <key>`. The key is **not bundled** — supply it via
`--api-key` or the `DIP_API_KEY` environment variable, else the header is omitted
and the API returns `401`. Request a personal key from
`parlamentsdokumentation@bundestag.de`. The Bundestag also publishes a shared,
rate-limited key (rotates yearly); for CI / live testing it can be fetched
out-of-band (never from the CLI) via `scripts/fetch-api-key.mjs`
(`npm run fetch-key`).

---

## Resources (endpoints)

Each resource is exposed under `/api/v1/<resource>` with a list endpoint
(`/<resource>`) and a single-item endpoint (`/<resource>/<id>`). The CLI mirrors
this as `<resource> list` and `<resource> get <id>`.

**Vorgang (procedure).** A legislative or parliamentary *process* — e.g. a bill,
a motion (Antrag), an interpellation (Anfrage) — tracked from introduction to
conclusion. The central entity that ties documents, activities and people
together. CLI: `vorgang`. Client: `client.vorgaenge`.

**Vorgangsposition (procedure step).** A single *step* within a Vorgang — one
event in its history (e.g. a first reading, a committee referral, a vote). A
Vorgang has many Vorgangspositionen. CLI: `vorgangsposition`. Client:
`client.vorgangspositionen`.

**Drucksache (printed paper).** A formal parliamentary *document* — bills,
motions, reports, answers to questions, etc. — identified by a paper number
within an electoral term. CLI: `drucksache`. Client: `client.drucksachen`.

**Drucksache-Text.** The same Drucksachen, but with the **extracted full text**
of the document included in the payload (a separate, heavier endpoint).
CLI: `drucksache-text`. Client: `client.drucksacheText`.

**Plenarprotokoll (plenary protocol).** The stenographic *minutes* of a plenary
sitting of the Bundestag or Bundesrat. CLI: `plenarprotokoll`. Client:
`client.plenarprotokolle`.

**Plenarprotokoll-Text.** The Plenarprotokolle with the **extracted full text**
of the minutes included. CLI: `plenarprotokoll-text`. Client:
`client.plenarprotokollText`.

**Aktivität (activity).** A recorded *action* by a person within a procedure —
e.g. a speech, a question, a signature on a motion. Links a Person to a Vorgang.
CLI: `aktivitaet`. Client: `client.aktivitaeten`.

**Person.** A *person* appearing in the materials — typically a member of
parliament (Abgeordnete:r), but also other actors. CLI: `person`. Client:
`client.personen`.

---

## Identifiers, filters & pagination

**id.** Every resource document has a numeric `id`, used by the `get` endpoint
(`drucksache get 123456`) and by the `f.id` filter. The CLI's `--id` flag is
shorthand for `f.id` and is repeatable.

**`f.*` filters (Filter).** DIP filters are query parameters prefixed with `f.`,
e.g. `f.titel` (title), `f.id`, `f.wahlperiode`, `f.datum.start` /
`f.datum.end` (date range), `f.vorgangstyp`, `f.dokumentart`,
`f.aktualisiert.start` (last-updated range). The CLI passes them verbatim via
`--filter key=value` (repeatable); only the first `=` splits key from value, so a
value may itself contain `=`. Repeating the same key sends repeated query keys
(`?f.id=1&f.id=2`), which DIP treats as an OR set.

**cursor.** DIP list endpoints are **cursor-paginated**. A list response carries
a `cursor`; pass it back via `--cursor` (CLI) or `{ cursor }` (library) to fetch
the next page. The cursor is opaque — treat it as a token, not a number. When the
returned cursor stops changing, you have reached the end.

**numFound.** The total number of documents matching a list query (across all
pages), returned in the list envelope alongside the current page's `documents`.

**documents.** The array of resource documents in the current page of a list
response. Each is exposed as a faithful raw `JsonObject` (the per-resource
payloads are large and resource-specific, so they are not narrowed to typed
fields).

**Wahlperiode (electoral term).** The numbered legislative period of the
Bundestag (e.g. the 20th Wahlperiode). Most resources carry a `wahlperiode`
field and can be filtered with `f.wahlperiode`; document numbers are scoped to a
Wahlperiode.

**Vorgangstyp (procedure type).** The classification of a Vorgang (e.g.
*Gesetzgebung* — legislation, *Antrag* — motion, *Kleine Anfrage* — minor
interpellation). Filterable via `f.vorgangstyp`.

**Dokumentart (document type).** For Drucksachen, whether a document is a
*Drucksache* or an *Antwort* (answer); for Plenarprotokolle the analogous
classification. Filterable via `f.dokumentart`.

**Datum (date).** The date a document/activity is dated. Date-range filtering
uses `f.datum.start` and `f.datum.end` (ISO `YYYY-MM-DD`). The query builder
serialises `Date` values to full ISO-8601 strings.

**Zuordnung (assignment).** Some resources can be filtered by chamber/assignment
(`f.zuordnung`), distinguishing Bundestag (`BT`) from Bundesrat (`BR`) materials.

---

## API behaviour & errors

**Base URL.** Defaults to `https://search.dip.bundestag.de`; override with
`--base-url` (CLI) or `baseUrl` (library). All resource paths are under
`/api/v1`.

**Rate limiting.** The shared key in particular is rate-limited; the API returns
**429** when exceeded. The client retries **429** and **503** automatically with
linear backoff (`--max-retries`, default 2).

**Credential stripping on redirect.** The `Authorization` header (and
`X-API-Key` / `Cookie`) is removed on any redirect that crosses origins, so the
API key is never leaked to a host other than the one you targeted. Same-origin
redirects keep it.

**Error types.** [`errors.ts`](src/client/errors.ts): `DipApiError` (non-2xx,
carries `status`/`detail`/`url`/`method`/`body`, with `isRetryable` for 429/503),
`DipNetworkError` (transport failure/timeout), `DipParseError` (bad JSON), and
`DipUsageError` (a CLI usage error such as an empty `get` id), all extending
`DipError`. Exit codes: `0` success, `2` usage errors, `4` on a `404`, `1` for
any other runtime error (including `401` when the key is missing/expired).

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `DipClient`, resource groups, the request engine, transport, retry/backoff,
> error types, query builder — now live in **[DEVELOPING.md](DEVELOPING.md)**.
