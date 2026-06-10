---
name: dip-document-digest
description: >
  Find, retrieve and digest Bundestag documents — Drucksachen (printed papers)
  and Plenarprotokolle (plenary minutes) — including their full text, using the
  dip-bundestag-cli. Trigger when the user asks "summarize Drucksache 20/6363",
  "what does the Haushaltsgesetz say?", "pull the transcript of the plenary
  debate on X", "find recent papers about Klimaschutz and digest them", "search
  the parliamentary record for Y and tell me what's in it", or wants the
  substance (not just metadata) of German parliamentary documents. Resolves the
  doc, fetches the heavy full-text endpoint, and produces a sourced digest with
  citations.
version: 1.0.0
userInvocable: true
---

# DIP Document Digest

Go from a keyword or a document number to a **sourced digest of what the document actually
says** — pulling the extracted full text from DIP's heavy `*-text` endpoints and citing the
Drucksachen-/Protokoll-Nummer, not just listing titles.

## Tooling

This skill drives the `dip` command. **Before anything else, validate it is available** — run `command -v dip` (or `dip --version`). If it is not on your PATH, STOP and inform the user that the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`), read-only over
the Bundestag DIP API, **one resource per call**.

**API key is mandatory** — `401` (CLI exit `1`) without one. Set `DIP_API_KEY` (preferred)
or pass `--api-key <key>` (global; before or after the subcommand). There is **no working
bundled key** (the shared key rotates yearly and is usually expired); request a personal
key from `parlamentsdokumentation@bundestag.de`. On a `401`, tell the user a key is needed.

Use `--compact`. An empty result is `{ "numFound": 0, "documents": [] }`, exit `0` — a
valid "nothing matched", not an error.

## The four resources you'll use

| CLI command | What it returns |
|---|---|
| `drucksache` | Printed-paper **metadata only** (fast, list-friendly) |
| `drucksache-text` | The same papers **with extracted full text** (`text` field; heavy) |
| `plenarprotokoll` | Plenary-minutes **metadata only** |
| `plenarprotokoll-text` | The same minutes **with full text** (heavy) |

> **Trap — don't list on the `*-text` endpoint to browse.** The `-text` payloads embed the
> entire document body, so a broad `drucksache-text list` is huge and slow. **Search on the
> metadata endpoint, narrow to the one(s) you want, then fetch full text** — either via
> `drucksache-text get <id>` for a single doc, or a tightly-filtered `drucksache-text list`
> (by `f.dokumentnummer` / `f.id`).

## Step 1 — Find the document(s)

If the user gave a document number (e.g. "20/6363") or id, jump to Step 2. Otherwise search
metadata by keyword, **always scoped by term**:

```bash
dip --compact drucksache list --filter f.titel=Klimaschutz --filter f.wahlperiode=21
```

Filter notes (grounded in DIP's spec):

| Filter | Use |
|---|---|
| `f.titel=<text>` | Free-text title search. **Best-effort** — works upstream but is *not* in DIP's formal spec, so it can over- or under-match. The main way to search by topic. |
| `f.wahlperiode=<n>` | Term — **always set it** (current **21**, prior **20**) to cut volume |
| `f.datum.start` / `f.datum.end` | Date range, plain `YYYY-MM-DD` |
| `f.aktualisiert.start` / `.end` | Last-updated range — **requires full ISO datetime** `YYYY-MM-DDThh:mm:ss`; a bare date returns `400`. Use this for "what changed since…" monitoring. |
| `f.zuordnung=BT\|BR` | Chamber |
| `f.dokumentnummer=<n>` | Exact paper number, e.g. `20/6363` |
| `f.drucksachetyp=<t>` | Paper type (Antrag, Gesetzentwurf, …) |
| `f.id=<n>` (or `--id`) | Specific id(s); `--id` repeatable for an OR-set |

Metadata fields that matter for picking the right hit: `id`, `titel`, `dokumentnummer`,
`drucksachetyp`, `datum`, `wahlperiode`, `herausgeber`, `autoren_anzeige[]`,
`vorgangsbezug[]` (linked procedures), `fundstelle.pdf_url`. For protocols also `datum` and
`dokumentnummer` (e.g. "20/115" = 115th sitting of WP 20). Show the top few candidates
(number + title + date) and confirm before fetching full text.

## Step 2 — Fetch the full text

Single document (preferred):

```bash
dip drucksache-text get 282486            # by id → has the `text` field
dip plenarprotokoll-text get 5678         # plenary transcript
```

Or pin by number without first knowing the id:

```bash
dip --compact drucksache-text list --filter f.dokumentnummer=20/6363 --filter f.wahlperiode=20
```

Text-endpoint fields: `text` (the extracted body — the substance), `titel`, `datum`,
`wahlperiode`, `dokumentart`, `abstract` (short summary if present), `fundstelle.pdf_url`
(authoritative PDF), `vorgangsbezug[]` (the procedure(s) this doc belongs to).

> **Traps in the text.** `text` is **OCR/extraction output** — expect hyphenation across
> line breaks, header/footer noise, and page artefacts; clean lightly before quoting.
> Plenarprotokoll `text` is the **whole sitting**, often hundreds of KB covering many
> unrelated agenda items — you must locate the relevant Tagesordnungspunkt/agenda section
> yourself (search the text for the topic or speaker) rather than digesting the entire day.
> A document with no extracted text yet returns an empty/absent `text` — fall back to
> `fundstelle.pdf_url` and say the body isn't extracted.

## Step 3 — Digest

- **Drucksache:** summarize the request/proposal, who brought it (`autoren_anzeige` /
  `urheber`), the core demands or legislative changes, and (for Anfragen) the questions
  asked / answers given. Cite the `dokumentnummer`.
- **Plenarprotokoll:** isolate the relevant agenda item; summarize the debate — main
  positions by Fraktion and the outcome (vote, if recorded) — naming speakers. Cite the
  sitting number and date.
- Link the document back to its **procedure(s)** via `vorgangsbezug[]`, and offer
  **dip-procedure-tracker** if the user wants the full legislative timeline.

## Step 4 — Present

```
Drucksache 20/6363 (WP 20, 2023-04-19) — Gesetzentwurf der Bundesregierung
Gebäudeenergiegesetz (Heizungsgesetz)

Kern: Pflicht, neue Heizungen ab 2024 zu mind. 65 % mit erneuerbaren Energien zu
betreiben; Übergangsfristen, Härtefälle, Förderung. Einbringer: Bundesregierung.
Bezug: Vorgang 282486 (→ dip-procedure-tracker für den Verlauf).
Quelle: https://dserver.bundestag.de/btd/20/063/2006363.pdf
```

Rules:
- **Always cite** `dokumentnummer`/sitting number, date, and the `fundstelle.pdf_url`.
- Quote sparingly from `text`, and clean obvious OCR artefacts; don't paraphrase beyond
  what the text supports.
- For protocols, **never digest the whole day** — say which agenda item you covered.
- For "what changed since X" / monitoring requests, use `f.aktualisiert.start` with a full
  ISO datetime on the metadata endpoint, summarize counts and the notable new/updated docs,
  and only fetch full text for the ones the user wants.
- Note explicitly when a document's text isn't extracted (point to the PDF instead).
