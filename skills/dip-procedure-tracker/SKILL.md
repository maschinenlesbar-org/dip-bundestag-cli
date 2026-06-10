---
name: dip-procedure-tracker
description: >
  Track a Bundestag legislative procedure (Vorgang) end to end using the
  dip-bundestag-cli. Trigger when the user asks "what's the status of the
  Heizungsgesetz?", "track the Bürgergeld bill", "where is procedure 282486 in
  the process?", "show the readings and committee referrals for this law", "did
  the Bundestag pass X?", or wants the timeline / current Beratungsstand of a
  German parliamentary process. Resolves the Vorgang, then assembles its
  Vorgangspositionen (steps) in chronological order, surfacing votes, committee
  referrals and the documents at each step — the cross-resource join the CLI does
  not do for you.
version: 1.0.0
userInvocable: true
---

# DIP Procedure Tracker

Turn a procedure (**Vorgang**) into a single, chronological status briefing — the
introduction, each reading, committee referrals, the vote, and where it stands now —
instead of one Vorgang blob plus a separate, unordered list of steps.

## Tooling

This skill drives the `dip` command. **Before anything else, validate it is available** — run `command -v dip` (or `dip --version`). If it is not on your PATH, STOP and inform the user that the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

All data comes from the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`), a read-only
client over the Bundestag DIP API. It queries **one resource per call**; the whole job of
this skill is the cross-resource join (Vorgang ↔ Vorgangspositionen) the CLI deliberately
does not do.

**API key is mandatory.** DIP returns `401` (CLI exit `1`) without one. Supply it via the
`DIP_API_KEY` env var (preferred) or the global `--api-key <key>` flag (works before or
after the subcommand). There is **no working bundled key** — the published shared key
rotates yearly and is usually expired; for a guaranteed key request a personal one from
`parlamentsdokumentation@bundestag.de`. If you hit a `401`, stop and tell the user a key is
needed rather than retrying.

Pass `--compact` so each result is one line, easy to pipe into `jq`. A `list` that matches
nothing returns `{ "numFound": 0, "documents": [] }` and exits `0` — that is **not** an
error, it means "no such procedure / no steps".

## Step 1 — Resolve the Vorgang id

If the user gave a numeric id, skip to Step 2. Otherwise search by title keyword:

```bash
dip --compact vorgang list --filter f.titel=Heizungsgesetz --filter f.wahlperiode=20
```

- `f.titel` is a **free-text** match and is the only practical way to find a procedure by
  name — but note it is **not in DIP's formal filter spec**, so treat it as best-effort:
  it can return loosely-related hits and occasionally misses. Always scope it with
  `f.wahlperiode` (the current term is **21**, the prior **20**) to cut noise, and confirm
  the right hit by reading each candidate's `titel` / `abstract` / `vorgangstyp` before
  committing.
- The envelope is `{ numFound, documents[], cursor }`. If `numFound` is large, show the top
  few `titel`s and ask the user which one, rather than guessing.
- **`f.vorgangstyp` is unreliable** (also not in the formal spec). Don't filter on it; read
  the `vorgangstyp` field off the results and filter client-side if the user wants only
  e.g. Gesetzgebung.

The Vorgang fields that matter:

| Field | Meaning |
|---|---|
| `id` | The procedure id — the join key for Step 2 |
| `titel` | Title of the procedure |
| `abstract` | Short summary (often the best one-line description) |
| `vorgangstyp` | Type — `Gesetzgebung`, `Antrag`, `Kleine Anfrage`, … |
| `beratungsstand` | **Current status** in plain German (e.g. "Verkündet", "Dem Bundesrat zugeleitet"). The headline of the briefing. |
| `wahlperiode` | Electoral term |
| `datum` | Date of the latest position (recency) |
| `initiative` | Who initiated it (e.g. fractions, Bundesregierung) |
| `inkrafttreten[]` / `verkuendung[]` | Present only once a law is enacted/promulgated — strong "it passed" signal |
| `zustimmungsbeduerftigkeit[]` | Whether Bundesrat consent is required |

## Step 2 — Pull the steps (Vorgangspositionen) for that id

This is the join. **`f.vorgang` is supported on `vorgangsposition`, not on `vorgang`** —
that's the non-obvious part:

```bash
dip --compact vorgangsposition list --filter f.vorgang=282486
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
| `beschlussfassung[]` | **The vote**, when there was one: `beschlusstenor` (outcome, e.g. "Annahme der Vorlage"), `abstimmungsart`, `mehrheit`, `dokumentnummer` |
| `ueberweisung[]` | **Committee referral(s)**: `ausschuss` (committee), `ausschuss_kuerzel`, `federfuehrung` (lead committee, boolean), `ueberweisungsart` |
| `urheber[]` | Originators (`bezeichnung`, `rolle`) |
| `aktivitaet_anzahl` | How many activities (speeches/questions) attach to this step |
| `abstract` | Step summary, if any |

## Step 3 — Assemble the timeline

1. **Sort the positions ascending by `datum`** (oldest → newest). API order is not
   chronological.
2. Tag each step with its chamber (`zuordnung`) so a reader sees the BT/BR ping-pong.
3. Pull out the two things that carry real news:
   - **Votes** — any step with `beschlussfassung[]`: report `beschlusstenor` +
     `abstimmungsart` + `mehrheit`. "Annahme" = adopted, "Ablehnung" = rejected.
   - **Committee referrals** — any step with `ueberweisung[]`: list the committees, mark
     the `federfuehrung` (lead) one.
4. Cross-check the Vorgang's `beratungsstand` against the last step; if `verkuendung[]` /
   `inkrafttreten[]` is populated on the Vorgang, the law is **enacted** — say so and give
   the date.

## Step 4 — Brief the user

Lead with a one-line verdict (status), then the timeline, then notable votes/referrals.

```
Gebäudeenergiegesetz (Heizungsgesetz) — WP 20 · Gesetzgebung
Status: Verkündet (in Kraft seit 01.01.2024)

Timeline:
  2023-04-19  BT  Gesetzentwurf eingebracht (Drs 20/6363)
  2023-05-23  BT  1. Beratung → überwiesen an Ausschuss für Klimaschutz und Energie (federführend), +3 mitberatend
  2023-09-08  BT  2./3. Beratung — ✅ Annahme der Vorlage (namentliche Abstimmung, Mehrheit der Koalition)
  2023-09-29  BR  Durchgang — kein Einspruch
  2023-10-19  —   Verkündung (BGBl.)

Notable:
  • Vote 2023-09-08: Annahme der Vorlage, namentliche Abstimmung.
  • Lead committee: Ausschuss für Klimaschutz und Energie.
```

Rules:
- **Lead with `beratungsstand`** — it's the answer to "where is it?".
- Always render the timeline **chronologically**, with chamber tags.
- Surface every **vote** (`beschlusstenor`) and the **lead committee** (`federfuehrung`).
- For each step, cite the document (`fundstelle.dokumentnummer`) and offer its `pdf_url`.
- If the user wants the actual text of a step's document, hand off to **dip-document-digest**
  (`drucksache-text` / `plenarprotokoll-text`).
- A procedure with one step (e.g. an unanswered Kleine Anfrage) is normal — report it
  plainly rather than implying data is missing.
- Don't infer "passed" from a 1. Beratung; only `Annahme`-tenor votes or
  `verkuendung`/`inkrafttreten` mean enacted.
