---
name: dip-member-dossier
description: >
  Build a dossier on a member of the Bundestag (or other DIP actor) using the
  dip-bundestag-cli. Trigger when the user asks "who is MP X?", "what's
  Annalena Baerbock's role / fraction / Wahlkreis?", "profile this Abgeordnete",
  "which committees does X sit on?", "look up person 7240", or wants a
  capsule biography / role history of a Bundestag member from the parliamentary
  record. Resolves the person, reads their roles across electoral terms, and can
  pull the documents/activities tied to them — handling the fact that DIP has no
  reliable name filter on the person endpoint.
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
(preferred) or pass `--api-key <key>` (global; before or after the subcommand). There is
**no working bundled key**; the published shared key rotates yearly and is usually expired.
Request a personal key from `parlamentsdokumentation@bundestag.de`. On a `401`, tell the
user a key is required instead of retrying.

Use `--compact`. An empty result is `{ "numFound": 0, "documents": [] }`, exit `0` — not an
error.

## Step 1 — Resolve the person — the hard part

> **Critical trap.** The `/person` endpoint has **no working name filter**. `f.person` and
> `f.titel` are *not* in DIP's formal spec for this resource and are silently ignored or
> unreliable. The only formal filters here are `f.wahlperiode`, `f.datum.*`,
> `f.aktualisiert.*`, and `f.id`. So you cannot just `person list --filter f.person=Merkel`
> and trust it.

Resolve a person one of two ways:

- **If the user gave a numeric id**, go straight to `person get`:
  ```bash
  dip --compact person get 7240
  ```
- **If the user gave a name**, scope by electoral term and match client-side. List the
  term and walk the pages, filtering on the `nachname` / `vorname` fields yourself:
  ```bash
  dip --compact person list --filter f.wahlperiode=21 \
    | jq -r '.documents[] | select(.nachname=="Baerbock") | "\(.id)\t\(.vorname) \(.nachname)\t\(.titel)"'
  # capture .cursor and repeat with --cursor until cursor stops changing
  ```
  The list is large — paginate with `--cursor` (capture `cursor` from each response, pass
  it back; stop when it no longer changes). If you find several matches (common surnames),
  list them with id + Fraktion and ask the user which one. If you genuinely can't find the
  person within a couple of pages, say so and ask for the id or the correct term — don't
  invent one.

Person fields:

| Field | Meaning |
|---|---|
| `id` | Person id (for `get`, and for follow-up filters) |
| `nachname` / `vorname` / `namenszusatz` | Name parts — **match on these**, not `titel` |
| `titel` | Display name, e.g. "Dr. Annalena Baerbock, MdB" |
| `wahlperiode` | Term(s) the record covers |
| `basisdatum` | Base date of the record |
| `person_roles[]` | **The substance** — see below |

## Step 2 — Read the roles

`person_roles[]` is where party, function and Wahlkreis live. Each entry:

| Field | Meaning |
|---|---|
| `funktion` | Role, e.g. "Mitglied des Bundestages", "Bundesministerin", "Abg." |
| `funktionszusatz` | Role detail |
| `fraktion` | **Party / parliamentary group** (e.g. "BÜNDNIS 90/DIE GRÜNEN") |
| `nachname` / `vorname` / `namenszusatz` | Name as held in that role |
| `wahlperiode_nummer[]` | Which term(s) this role applied to |
| `wahlkreiszusatz` | Constituency detail |
| `ressort_titel` | Ministry, if a government role |
| `bundesland` | State |

A person can hold several roles across terms (e.g. MdB in WP19/20, then Bundesministerin).
Group roles by `fraktion` / `funktion` and show the term spans from `wahlperiode_nummer`.

## Step 3 — (Optional) documents & activities tied to the person

> **Trap.** There is **no `f.person` filter on `aktivitaet` either** — you cannot list a
> person's activities directly by person id. The activity/document endpoints join on
> *documents* (`f.drucksache`, `f.plenarprotokoll`, `f.vorgang`), not on people.

So a person's parliamentary output is reached **indirectly**:

- The most reliable signal of authorship is in **Drucksachen**: search recent papers and
  match the person in `autoren_anzeige[]` / `urheber[]` (`urheber[].bezeichnung`)
  client-side:
  ```bash
  dip --compact drucksache list --filter f.wahlperiode=21 --filter f.datum.start=2025-01-01 \
    | jq -r '.documents[] | select([.autoren_anzeige[]?] | any(test("Baerbock"))) | "\(.datum)\t\(.dokumentnummer)\t\(.titel)"'
  ```
- If the user only wants the profile (role/party/Wahlkreis), **skip this step** — it's
  expensive (broad date scan + client-side match) and only loosely attributable. Offer it
  as a follow-up rather than running it by default.

## Step 4 — Present the dossier

```
Annalena Baerbock — Person 7240
Aktuell: Bundesministerin (Auswärtiges Amt) · zuvor MdB, BÜNDNIS 90/DIE GRÜNEN

Rollen:
  • WP 19–20  MdB · BÜNDNIS 90/DIE GRÜNEN · Wahlkreis Potsdam
  • WP 20–21  Bundesministerin des Auswärtigen (Auswärtiges Amt)

(Optional) jüngere Drucksachen mit Beteiligung: 3 in 2025 — frag nach für die Liste.
```

Rules:
- Lead with **current role + Fraktion** from the most recent `person_roles[]` entry.
- Show the role history with term spans (`wahlperiode_nummer`); distinguish parliamentary
  (MdB) from government roles (`ressort_titel`).
- Be explicit about the name-resolution caveat if you had to match client-side ("matched
  on surname within WP 21").
- Don't fabricate committee memberships, vote records, or biography facts the DIP record
  doesn't contain — DIP carries roles, not full biographies. Say what's absent.
- Offer `person get <id>` for the raw record, and the optional document scan as a follow-up.
