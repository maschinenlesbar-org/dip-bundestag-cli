# dip-bundestag-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for the
**Bundestag parliamentary record**, all powered by the **[dip](README.md)** CLI over the
[Bundestag DIP API](https://dip.bundestag.de/über-dip/hilfe/api)
(`search.dip.bundestag.de/api/v1`).

Each skill teaches Claude how to drive the `dip` CLI to answer a specific, real-world
question — "where is this bill in the process?", "who is this MP?", "summarize this
Drucksache" — and to report the answer with citations rather than guesswork. They encode
the cross-resource joins the bare CLI doesn't do (Vorgang ↔ Vorgangspositionen, doc ↔
procedure) and the parts that are easy to get wrong (which filters DIP actually supports,
the metadata-vs-full-text split, OCR noise in transcripts) so Claude doesn't rediscover
them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **dip-procedure-tracker** | Resolves a procedure (Vorgang), assembles its steps (Vorgangspositionen) chronologically, and surfaces votes, committee referrals and current Beratungsstand. | "what's the status of the Heizungsgesetz?", "track procedure 282486", "did the Bundestag pass X?" |
| **dip-member-dossier** | Resolves a person (handling DIP's missing name filter), reads their roles/Fraktion/Wahlkreis across terms, and optionally finds tied documents. | "who is MP X?", "what's Baerbock's role and party?", "look up person 7240" |
| **dip-document-digest** | Searches Drucksachen / Plenarprotokolle, pulls the heavy full-text endpoints, and produces a sourced digest with citations. | "summarize Drucksache 20/6363", "digest the debate on X", "find recent papers about Klimaschutz" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `dip` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/dip-bundestag-cli   # installs the `dip` bin
  ```
- **A DIP API key.** Unlike some sibling CLIs, DIP **requires a key** — there is no usable
  bundled one (the published shared key rotates yearly and is usually expired). Supply it
  via the `DIP_API_KEY` environment variable (preferred) or the global `--api-key <key>`
  flag. Request a personal key free of charge from `parlamentsdokumentation@bundestag.de`.
  Without a key, every request returns `401`.

  ```bash
  export DIP_API_KEY=your-personal-key
  ```

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/dip-bundestag-cli
/plugin install dip-bundestag@dip-bundestag-skills
```

The first command registers the marketplace; the second installs the `dip-bundestag`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/dip-bundestag-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/dip-procedure-tracker/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Make sure `DIP_API_KEY` is set, then just ask in natural language:

> What's the status of the Heizungsgesetz — show me the readings and the vote.

> Who is person 7240, and which Fraktion are they in?

> Find recent Drucksachen about Klimaschutz in WP 21 and summarize the top one.

You can also invoke a skill explicitly with its slash command, e.g. `/dip-procedure-tracker`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which `dip`
subcommands to call, in what order, and how to interpret the JSON. The skills encode the
non-obvious parts of this API, for example:

- **the key is mandatory and there's no working default** — the published shared key
  rotates yearly and is normally expired, so a `401` (CLI exit `1`) means "set
  `DIP_API_KEY`", not "retry";
- **`f.vorgang` lives on `vorgangsposition`, not on `vorgang`** — the procedure→steps join
  is `vorgangsposition list --filter f.vorgang=<id>`, and the steps come back **unordered**
  (sort by `datum`) (see **dip-procedure-tracker**);
- **the `/person` endpoint has no working name filter** — `f.person` / `f.titel` are not in
  DIP's formal spec there, so you resolve a person by id or by paging `person list` under
  an `f.wahlperiode` scope and matching `nachname`/`vorname` client-side; the only formal
  person filters are `f.wahlperiode`, `f.datum.*`, `f.aktualisiert.*`, `f.id`
  (see **dip-member-dossier**);
- **`f.titel` and `f.vorgangstyp` work but are undocumented** — `f.titel` does free-text
  title search upstream yet isn't in the OpenAPI spec (best-effort), and `f.vorgangstyp` is
  unreliable; the CLI passes any `--filter` verbatim, so unknown filters are silently sent;
- **metadata vs full text** — `drucksache`/`plenarprotokoll` are light; the `*-text`
  variants embed the whole document body, so search on metadata and only fetch text for the
  doc you want; a Plenarprotokoll's `text` is the **entire sitting** (find the agenda item
  yourself) and is OCR output with hyphenation/header noise (see **dip-document-digest**);
- **`f.aktualisiert.*` needs a full ISO datetime** (`YYYY-MM-DDThh:mm:ss`) or DIP returns
  `400`, whereas `f.datum.*` takes a bare `YYYY-MM-DD`;
- **lists are cursor-paginated** — capture `cursor` from each response and pass it back via
  `--cursor`; you've reached the end when the cursor stops changing. An empty page is
  `{ "numFound": 0, "documents": [] }` at exit `0`, not an error.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
