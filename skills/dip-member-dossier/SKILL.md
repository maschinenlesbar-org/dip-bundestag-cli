---
name: dip-member-dossier
description: >
  Build a dossier on a member of the Bundestag (or other DIP actor) using the
  dip-bundestag-cli. Trigger when the user asks "who is MP X?", "what's
  Annalena Baerbock's role / fraction / Wahlkreis?", "profile this Abgeordnete",
  "which committees does X sit on?", "look up person 7240", or wants a
  capsule biography / role history of a Bundestag member from the parliamentary
  record. Resolves the person by name or id, reads their current function and
  Fraktion plus earlier roles, and can pull the activities (speeches, questions)
  tied to them.
version: 1.0.0
userInvocable: true
---

# DIP Member Dossier

Produce a capsule profile of a person in the parliamentary record — name, party
(Fraktion), function, Wahlkreis, and role history across terms — plus, on request, the
recent documents and activities tied to them.

## Tooling

This skill drives the `dip` command. **Before anything else, validate it is available** — run `command -v dip` (or `dip --version`). If it is not on your PATH, STOP and inform the user that the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `dip` CLI (`@maschinenlesbar.org/dip-bundestag-cli`), read-only over
the Bundestag DIP API, **one resource per call**.

**API key is mandatory** — DIP answers `401` (CLI exit `1`) without one. Set `DIP_API_KEY`
(preferred) or pass `--api-key <key>` (global; before or after the subcommand). No key is
bundled with the CLI. The Bundestag publishes a public key on its DIP API help page,
https://dip.bundestag.de/über-dip/hilfe/api (stated there in 2026 as valid until the end of
May 2027); a personal key can be requested from `parlamentsdokumentation@bundestag.de`. On a
`401`, stop and tell the user a valid key is needed and where to get it instead of retrying.

Use `--compact`. An empty result is `{ "numFound": 0, "documents": [] }`, exit `0` — not an
error.

## Step 1 — Resolve the person

- **If the user gave a numeric id**, go straight to `person get`:
  ```bash
  dip --compact person get 1502
  ```
- **If the user gave a name**, use the `f.person` filter, scoped by electoral term:
  ```bash
  dip --compact person list --filter f.person=Baerbock --filter f.wahlperiode=21 \
    | jq -r '.documents[] | "\(.id)\t\(.titel)"'
  ```
  `f.person` matches a **complete** first or last name (`Klöckner` finds Julia Klöckner,
  `Klöck` finds nothing); several words are searched as the phrase "Nachname Vorname".
  Common surnames return several people (`f.person=Schmidt`) — list them with id + `titel`
  and ask which one. Drop `f.wahlperiode` for people outside the current term.

> **If `f.person` finds nothing**, the name may be spelled differently in DIP. Fall back to
> paging `person list --filter f.wahlperiode=<n>` and matching `nachname` / `vorname`
> client-side, **to the last page**: the list is ordered by `datum`, not by name, at 100
> per page, and WP 21 alone spanned 9 pages on 2026-09-15. Capture `cursor` from each
> response and pass it back with `--cursor` until it stops changing. Only then say the
> person wasn't found and ask for the id or the correct term — don't invent one.

Person fields (top level — the **current** state):

| Field | Meaning |
|---|---|
| `id` | Person id (for `get`, and for `f.person_id` in Step 3) |
| `nachname` / `vorname` / `namenszusatz` | Name parts — **match on these**, not `titel` |
| `titel` | Display name with current function and Fraktion, e.g. "Annalena Baerbock, MdB, BÜNDNIS 90/DIE GRÜNEN" |
| `funktion[]` | Current function, abbreviated: `MdB`, `Bundesmin.`, `Parl. Staatssekr.`, `MdBR`, … |
| `fraktion[]` | Current Fraktion — only when `funktion` is `MdB`; a member whose current function is `Bundesmin.`, `Bundeskanzl.` or `Bundestagsvizepräs.` has none here |
| `ressort[]` | Ministry, for a government function |
| `bundesland[]` / `funktionszusatz[]` | Land and office for Bundesrat members (e.g. "Ministerin für …") |
| `wahlkreiszusatz` | Place added to tell namesakes apart ("Wetzlar" in "Dagmar Schmidt (Wetzlar)"); rare, and not a full Wahlkreis |
| `wahlperiode[]` | Term(s) the person appears in |
| `datum` / `basisdatum` | Latest and first date in the record |

## Step 2 — Read the earlier roles

`person_roles[]` holds **other or earlier** roles and name variants, and many records have
none at all. Current function and Fraktion are the top-level fields above. Each entry:

| Field | Meaning |
|---|---|
| `ressort_titel` | Ministry of an earlier government role — the role title itself is **not** given |
| `fraktion` | Fraktion held in those terms (e.g. an earlier `fraktionslos` spell) |
| `funktionszusatz` / `bundesland` | Office and Land of a Bundesrat role |
| `nachname` / `vorname` / `namenszusatz` | Name as held in that role (can differ from today's) |
| `wahlkreiszusatz` | Name suffix used then |
| `wahlperiode_nummer[]` | Which term(s) this role applied to |

There is **no `funktion` inside `person_roles[]`**: a ministerial role shows up only as
`ressort_titel` + terms. Say "Ressort Auswärtiges Amt (WP 20)", not "Bundesministerin",
unless another source in the record states the title.

## Step 3 — (Optional) activities tied to the person

`aktivitaet` takes the person id directly (`f.person_id`, or `f.person` by name), so a
member's speeches, questions and co-signed papers come back in one query:

```bash
dip --compact aktivitaet list --filter f.person_id=1502 --filter f.wahlperiode=21 \
  | jq -r '.documents[] | "\(.datum)\t\(.aktivitaetsart)\t\(.fundstelle.dokumentart) \(.fundstelle.dokumentnummer)\t\(.vorgangsbezug[0].titel // "")"'
```

`numFound` gives the total; page with `--cursor` for more than 100. `drucksache` has no
person filter — to find papers a person signed without going through `aktivitaet`, match
`autoren_anzeige[]` (objects with `id`, `titel`, `autor_titel`) client-side:
`select(any(.autoren_anzeige[]?; .id == "1502"))`.

If the user only wants the profile (function/Fraktion/roles), **skip this step** and offer
it as a follow-up.

## Step 4 — Present the dossier

```
Annalena Baerbock — Person 1502
Aktuell (laut DIP): MdB · BÜNDNIS 90/DIE GRÜNEN · in WP 18–21

Frühere Rollen:
  • WP 20  Ressort Auswärtiges Amt (Rollentitel nicht im Datensatz)

(Optional) Aktivitäten in WP 21 (Reden, Anfragen) — auf Nachfrage als Liste.
```

Rules:
- Lead with **current function + Fraktion** from the top-level `funktion[]` / `fraktion[]`.
- Show earlier roles with term spans (`wahlperiode_nummer`); distinguish parliamentary
  roles (`fraktion`) from government ones (`ressort_titel`).
- Say how you resolved the person ("`f.person=Baerbock` within WP 21", or "matched on
  surname across all WP 21 pages").
- Don't fabricate committee memberships, vote records, or biography facts the DIP record
  doesn't contain — DIP carries roles, not full biographies. Say what's absent.
- Offer `person get <id>` for the raw record, and the optional activity list as a follow-up.
