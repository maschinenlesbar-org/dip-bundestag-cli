# Examples

Real examples for the Claude Code skills of the `dip-bundestag` plugin, one per skill: a request,
the `dip` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026: dip-member-dossier and
dip-procedure-tracker with `dip` 0.3.0 (re-run after their notes on `--cursor` changed, with
the same answers), dip-document-digest with 0.2.0.
The data changes, so your results will differ; the ids shown work for trying the requests
yourself. Long lists are shortened.

Each skill starts by obtaining the API key once and reuses it on every later call:

```bash
dip obtain-key          # reads DIP's help document, verifies the key, prints it on stdout
DIP_API_KEY="<the key>" dip --compact …
```

`obtain-key` printed `Obtained the key from https://content.dip.bundestag.de/content-api/v1/content/help-api
and verified it against the live API.` on stderr. The key itself is left out below.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [dip-document-digest](#dip-document-digest) · [dip-member-dossier](#dip-member-dossier) · [dip-procedure-tracker](#dip-procedure-tracker)

## dip-document-digest

> The Greens sent the government questions about how the Gebäudemodernisierungsgesetz came about. What did they ask, and is there an answer yet?

```bash
dip --compact drucksache list --filter f.titel=Gebäudemodernisierungsgesetz --filter f.wahlperiode=21   # 7 hits
dip --compact drucksache-text get 290675        # Antwort 21/7982, with the question text
dip --compact vorgang list --filter f.titel=Gebäude --filter f.wahlperiode=21 \
  --filter f.vorgangstyp=Gesetzgebung                                                                  # to link the law itself
```

The search found only Kleine Anfragen and answers, no bill: the law is filed as "Gesetz zur Änderung
des Gebäudeenergiegesetzes, …". The newest hit is the government's answer of 10 Sep, and its text
is extracted now. Since an answer repeats every question in small print, the skill digested
questions and answers from that one document. It dropped URLs split across lines and the
printer's footer from the OCR text.

```
Drucksache 21/7982 (WP 21, 2026-09-10) — Antwort der Bundesregierung (BMWE)
on Kleine Anfrage 21/7563 of Dr. Alaa Alhamwi, Dr. Julia Verlinden, Hanna Steinmüller and the
Fraktion BÜNDNIS 90/DIE GRÜNEN: "Gesetzgebungsverfahren zum Gebäudemodernisierungsgesetz"

Premise of the questions: the adopted GModG drops the 65-percent rule (§ 71 GEG), allows fossil
heating beyond 2045, adds a Grüngasquote from 2028 and a "Bio-Treppe" from 2029.

Answered (37 questions):
  • Preface: the core of executive responsibility is not open to parliamentary inquiry; contacts
    are not logged in full, so the lists may be incomplete.
  • Q1–2 meetings: BMin Reiche with BDEW (Dohler, Andreae) on 23 Jul 2025 and with BDEW's
    board, management and steering groups on 12 Jan 2026, both "Wärmewende/GModG"; PSt
    Rouenhoff with ITGA-NRW/BTGA (20 Aug 2025) and BDI (16 Mar 2026). Q3 letters from the
    gas industry: none ("Fehlanzeige").
  • Q4–14 drafts and who pushed what: the statements of Länder and associations are on BMWE's
    website; the coalition agreement ("Wir werden das Heizungsgesetz abschaffen") applied from
    day one; "everyone is free to lobby"; most questions referred to the answer on Q4.
  • Q15–24 Bio-Treppe and quota: a supplier's bill confirms the Bio-Treppe, breaches carry fines;
    the Grüngas-/Grünheizölquote law is "in preparation" (no timetable); forecasts of supply and
    prices vary too widely to use.
  • Q25–32 ministries and constitution: BMWE and BMWSB wrote a joint draft; the government
    considers the law constitutional.
  • Q33–37 climate effect: the Bundestag passed the law on 10 Jul 2026, the Bundesrat raised no
    objection; an estimate of its climate effect is "being prepared"; no forecast of new gas
    heaters; the late answer to 21/6229 was due to inter-ministry coordination and research.

Procedure: Vorgang 338265 (Kleine Anfrage)
The law: Vorgang 334923, Verkündet in BGBl I 2026, 226 (2026-07-28)
Source: https://dserver.bundestag.de/btd/21/079/2107982.pdf
```

Next steps offered: the full answers to Q1–2 as a table, or run dip-procedure-tracker on Vorgang 334923.

## dip-member-dossier

> What does the Bundestag record say about Julia Klöckner: party, roles, and which terms?

```bash
dip --compact person list --filter f.person=Klöckner --filter f.wahlperiode=21   # 1 hit: id 224
dip --compact person get 224
```

`f.person` found her by surname in one request, so no paging was needed. Party and function sit
in the top-level `fraktion[]`/`funktion[]` arrays. `person_roles[]` holds only term numbers and
ministries, with no role title.

```
Julia Klöckner — Person 224
Current (WP 21): MdB · CDU/CSU        (titel "Julia Klöckner, MdB, CDU/CSU")

Terms in the record: WP 15, 16, 17, 19, 20, 21 (not 18) · basisdatum 2002-11-13 · latest 2026-09-10
Earlier roles:
  • WP 19  Ressort Bundesministerium für Ernährung und Landwirtschaft (role title not in the record)
  • WP 17  Ressort Bundesministerium für Ernährung, Landwirtschaft und Verbraucherschutz
  • WP 21  a role entry with her name only, no further detail
  (no role entries for WP 15, 16 and 20)

Not in the record: the title of either ministry role, Wahlkreis, Bundesland, committees, and no
Präsidium office (her current function is MdB).
```

Next steps offered: her WP 21 activities (`aktivitaet list --filter f.person_id=224 --filter f.wahlperiode=21`, paged with both filters repeated).

## dip-procedure-tracker

> Where does the federal budget for 2027 stand in the Bundestag? Has there been a vote?

```bash
dip --compact vorgang list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=21   # 14 hits
dip --compact vorgangsposition list --filter f.vorgang=338317                         # 33 steps, one page
```

Most of the 14 hits were Entschließungsanträge on the 2025 and 2026 budgets. The skill kept
`vorgangstyp` Gesetzgebung and took the 2027 bill. All 33 steps fit on one page (`numFound` 33),
so no `--cursor` call was needed. 26 steps belong to the first reading, mostly one per Einzelplan,
so the skill folded them into one line per sitting day. Neither `beschlussfassung` is a vote on
the bill: one is the referral, the other the Bundesrat's opinion. The Vorgang's abstract says
"Bundeshaushaltsplans 2026" although everything else is 2027, so its figures are quoted with
that caveat.

```
Haushaltsgesetz 2027 (HG 2027) — WP 21 · Gesetzgebung · Vorgang 338317
Status: Überwiesen. First reading done, now in the Haushaltsausschuss; no vote on adoption yet
Initiative: Bundesregierung (lead: Bundesministerium der Finanzen)
Bundesrat consent: "Nein, laut Gesetzentwurf (Drs 450/26)"

Timeline:
  2026-08-14  BT  Gesetzentwurf (Drs 21/7300)
  2026-08-14  BR  Gesetzentwurf (Drs 450/26, Berichtigung zu450/26) → Finanzausschuss (lead)
  2026-08-21  BT  Unterrichtung (Drs 21/7650): annex under § 28 (3) BHO for Epl 03, 19, 20
  2026-09-08  BT  1. Beratung (PlPr 21/91): Einbringung, general finance debate (Epl 08, 20, 32, 60),
                  Epl 12, 16, 24, 09
  2026-09-09  BT  1. Beratung (PlPr 21/92): Epl 04, 05, 14, 23
  2026-09-10  BT  1. Beratung (PlPr 21/93): Epl 06, 07, 10, 17, 25, 15
  2026-09-11  BT  1. Beratung (PlPr 21/94): Epl 11, 30, Schlussrunde → Überweisung (p. 11673C)
  2026-09-11  BR  Empfehlungen der Ausschüsse (Drs 450/1/26): Stellungnahme
  2026-09-25  BR  1. Durchgang (PlPr 1068): Stellungnahme under Art. 110 (3) GG → Beschlussdrucksache 450/26(B)

Notable:
  • Decision 2026-09-11: beschlusstenor "Überweisung" of 21/7300 and 21/7650. A referral, not a vote.
  • Decision 2026-09-25: the Bundesrat's Stellungnahme in the first passage. An opinion, not a vote.
  • Lead committee: Haushaltsausschuss (HaushA); no co-advising committees listed.
  • Debated with the Finanzplan des Bundes 2026 bis 2030 and the Haushaltsbegleitgesetz 2027;
    397 activities over the four sittings and the Bundesrat session.
  • Abstract figures: 555,436 Mrd Euro total, net borrowing up to 118,727 Mrd Euro,
    investment 56,272 Mrd Euro.
```

Next steps offered: dip-document-digest on the Schlussrunde in Plenarprotokoll 21/94 (pp. 11652–11673), or the Bundesrat's Stellungnahme 450/26(B).
