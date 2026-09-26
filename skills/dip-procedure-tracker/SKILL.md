---
name: dip-procedure-tracker
description: >
  Track a Bundestag legislative procedure (Vorgang) end to end using the
  dip-bundestag-cli. Trigger when the user asks "what's the status of the
  Heizungsgesetz?", "track the Bürgergeld bill", "where is procedure 298723 in
  the process?", "show the readings and committee referrals for this law", "did
  the Bundestag pass X?", or wants the timeline / current Beratungsstand of a
  German parliamentary process. Resolves the Vorgang, then assembles its
  Vorgangspositionen (steps) in chronological order, surfacing votes, committee
  referrals and the documents at each step — the cross-resource join the CLI does
  not do for you.
compatibility: >
  Requires the `dip` CLI (npm package @maschinenlesbar.org/dip-bundestag-cli) on
  PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to search.dip.bundestag.de. Needs the public API key
  via --api-key or DIP_API_KEY (`dip obtain-key` prints it).
---

# DIP Procedure Tracker

Turn a procedure (**Vorgang**) into a single, chronological status briefing — the
introduction, each reading, committee referrals, the vote, and where it stands now —
instead of one Vorgang blob plus a separate, unordered list of steps.

## Tooling

This skill drives the `dip` command. **Before anything else, validate it is available** — run `command -v dip` (or `dip --version`). If it is not on your PATH, STOP and inform the user that the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

All data comes from the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`), a read-only
client over the Bundestag DIP API. It queries **one resource per call**; the whole job of
this skill is the cross-resource join (Vorgang ↔ Vorgangspositionen) the CLI deliberately
does not do.

**API key — obtain it once, then reuse it.** DIP answers `401` (CLI exit `1`) without a
key, and **none is bundled**. Do not ask the user to go and find one: run

```bash
dip obtain-key
```

It reads the published key and **verifies it against the live API before printing it**, so
whatever it gives you actually authenticates. If it fails, it says where a working key comes
from — the help page https://dip.bundestag.de/über-dip/hilfe/api or a free personal key from
`parlamentsdokumentation@bundestag.de`. Relay that to the user and stop; never invent a key.

If `DIP_API_KEY` is already set in the environment, use it and skip `obtain-key`. **Keep the
key for the rest of the session** and put it on every later call — a shell `export` does not
survive between separate commands:

```bash
DIP_API_KEY="<the key>" dip --compact vorgang list --filter f.wahlperiode=21
```

Pass `--compact` so each result is one line, easy to pipe into `jq`. A `list` that matches
nothing returns `{ "numFound": 0, "documents": [] }` and exits `0` — that is **not** an
error, it means "no such procedure / no steps".

## Step 1 — Resolve the Vorgang id

If the user gave a numeric id, skip to Step 2. Otherwise search by title keyword:

```bash
dip --compact vorgang list --filter f.titel=Heizungsgesetz --filter f.wahlperiode=20
```

- `f.titel` searches **whole words in the title only** — not the `abstract`, and not word
  parts: `f.titel=Gebäudeenergie` finds nothing, `f.titel=Gebäudeenergiegesetzes` does.
  Always scope it with `f.wahlperiode` (the current term is **21**, the prior **20**), and
  confirm the right hit by reading each candidate's `titel` / `abstract` / `vorgangstyp`.
- **A law's popular name is often not in its title.** `f.titel=Gebäudemodernisierungsgesetz`
  (WP 21) returned only questions on 2026-09-15, no Gesetzgebung: the law is titled
  "Gesetz zur Änderung des Gebäudeenergiegesetzes, …" and the popular name appears only in
  its `abstract`. When the hits are only questions, retry with a word from the official
  title and narrow by type:
  ```bash
  dip --compact vorgang list --filter f.titel=Gebäude --filter f.wahlperiode=21 \
    --filter f.vorgangstyp=Gesetzgebung
  ```
  (Some titles carry the popular name in brackets, e.g. "… [Heizungsgesetz]".)
- `f.vorgangstyp` (e.g. `Gesetzgebung`, `Antrag`, `Kleine Anfrage`) filters by type
  server-side; use it to drop the questions that share a keyword with the bill.
- The envelope is `{ numFound, documents[], cursor }`. If `numFound` is large, show the top
  few `titel`s and ask the user which one, rather than guessing.

The Vorgang fields that matter:

| Field | Meaning |
|---|---|
| `id` | The procedure id — the join key for Step 2 |
| `titel` | Title of the procedure |
| `abstract` | Short summary (often the best one-line description). **Contains HTML** (`<br />`, `<strong>`, `&quot;`, `&ndash;`) — strip tags and decode entities before quoting |
| `vorgangstyp` | Type — `Gesetzgebung`, `Antrag`, `Kleine Anfrage`, … |
| `beratungsstand` | **Current status** in plain German (e.g. "Verkündet", "Dem Bundesrat zugeleitet"). The headline of the briefing. |
| `wahlperiode` | Electoral term |
| `datum` | Date of the latest position (recency) |
| `initiative` | Who initiated it (e.g. fractions, Bundesregierung) |
| `inkrafttreten[]` / `verkuendung[]` | Present only once a law is enacted/promulgated — strong "it passed" signal |
| `zustimmungsbeduerftigkeit[]` | Whether Bundesrat consent is required |

## Step 2 — Pull the steps (Vorgangspositionen) for that id

This is the join. **`f.vorgang` is supported on `vorgangsposition`, not on `vorgang`** —
that's the non-obvious part (on `vorgang` the CLI rejects it as an unknown filter, exit 2):

```bash
dip --compact vorgangsposition list --filter f.vorgang=298723
```

Each document is one step in the procedure's history. Page with `--cursor` if `numFound`
exceeds the page size (capture `cursor` from the response and pass it back). The fields
that matter per step:

| Field | Meaning |
|---|---|
| `vorgangsposition` | Step label, e.g. "1. Beratung", "Überweisung", "2./3. Beratung", "Verkündung" |
| `datum` | Date of the step — **sort by this** to build the timeline |
| `vorgangstyp` | Step's procedure type |
| `zuordnung` | Chamber: `BT` (Bundestag) or `BR` (Bundesrat) |
| `fundstelle` | The document at this step — `fundstelle.dokumentart` (Drucksache/Plenarprotokoll), `fundstelle.dokumentnummer`, `fundstelle.pdf_url`, `fundstelle.herausgeber` |
| `beschlussfassung[]` | **A decision** taken at this step: `beschlusstenor` (e.g. "Annahme in Ausschussfassung", but also "Überweisung", "Annahme Geschäftsordnungsantrag", a Bundesrat "Stellungnahme"), `abstimmungsart` and `mehrheit` (only when given, e.g. "Namentliche Abstimmung"), `dokumentnummer`, `seite` |
| `ueberweisung[]` | **Committee referral(s)**: `ausschuss` (committee), `ausschuss_kuerzel`, `federfuehrung` (lead committee, boolean), `ueberweisungsart` |
| `urheber[]` | Originators (`bezeichnung`, `rolle`) |
| `aktivitaet_anzahl` | How many activities (speeches/questions) attach to this step |
| `abstract` | Step summary, if any |

## Step 3 — Assemble the timeline

1. **Sort the positions ascending by `datum`** (oldest → newest). API order is not
   chronological.
2. Tag each step with its chamber (`zuordnung`) so a reader sees the BT/BR ping-pong.
3. Pull out the two things that carry real news:
   - **Votes** — steps whose `beschlussfassung[]` decides on the bill itself, typically
     "2. Beratung" / "3. Beratung": report `beschlusstenor` + `abstimmungsart` + `mehrheit`
     (the last two are often absent). "Annahme" = adopted, "Ablehnung" = rejected. **Not
     every `beschlussfassung` is a vote on the bill:** `Überweisung` at a 1. Beratung is the
     committee referral, `… Geschäftsordnungsantrag` is procedural, and a Bundesrat
     `Stellungnahme` is an opinion — report those as what they are.
   - **Committee referrals** — any step with `ueberweisung[]`: list the committees, mark
     the `federfuehrung` (lead) one.
4. Cross-check the Vorgang's `beratungsstand` against the last step; if `verkuendung[]` /
   `inkrafttreten[]` is populated on the Vorgang, the law is **enacted** — say so and give
   the date.

## Step 4 — Brief the user

Lead with a one-line verdict (status), then the timeline, then notable votes/referrals.

```
Gebäudeenergiegesetz (Heizungsgesetz) — Vorgang 298723 · WP 20 · Gesetzgebung
Status: Verkündet (BGBl I 2023, 280, 19.10.2023; in Kraft 01.10.2023 bzw. 01.01.2024)

Timeline:
  2023-04-20  BR  Gesetzentwurf (Drs 170/23)
  2023-05-12  BR  1. Durchgang — Stellungnahme (PlPr 1033)
  2023-05-17  BT  Gesetzentwurf (Drs 20/6875)
  2023-06-15  BT  1. Beratung — Überweisung an den Ausschuss für Klimaschutz und Energie (federführend) und weitere Ausschüsse (PlPr 20/109)
  2023-07-05  BT  Beschlussempfehlung und Bericht (Drs 20/7619)
  2023-09-08  BT  3. Beratung — ✅ Annahme in Ausschussfassung, namentliche Abstimmung (PlPr 20/120)
  2023-09-29  BR  2. Durchgang — kein Antrag auf Einberufung des Vermittlungsausschusses (PlPr 1036)

Notable:
  • Vote 2023-09-08: Annahme in Ausschussfassung, namentliche Abstimmung.
  • Lead committee: Ausschuss für Klimaschutz und Energie.
```

Rules:
- **Lead with `beratungsstand`** — it's the answer to "where is it?".
- Always render the timeline **chronologically**, with chamber tags.
- Surface every **vote** on the bill (`beschlusstenor`) and the **lead committee**
  (`federfuehrung`); list referrals and procedural decisions as such, not as votes.
- For each step, cite the document (`fundstelle.dokumentnummer`) and offer its `pdf_url`.
- If the user wants the actual text of a step's document, hand off to **dip-document-digest**
  (`drucksache-text` / `plenarprotokoll-text`).
- A procedure with one step (e.g. an unanswered Kleine Anfrage) is normal — report it
  plainly rather than implying data is missing.
- Don't infer "passed" from a 1. Beratung or from any `Annahme` tenor (a
  `Geschäftsordnungsantrag` can be "angenommen" too); only the adoption of the bill in the
  2./3. Beratung, or `verkuendung`/`inkrafttreten` on the Vorgang, mean passed/enacted.
