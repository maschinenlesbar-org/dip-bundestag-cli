# Examples

Real examples for the Claude Code skills of the `dip-bundestag` plugin, one per skill: a request,
the `dip` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `dip` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [dip-document-digest](#dip-document-digest) · [dip-member-dossier](#dip-member-dossier) · [dip-procedure-tracker](#dip-procedure-tracker)

## dip-document-digest

> The Greens sent the government questions about how the Gebäudemodernisierungsgesetz came about. What did they ask, and is there an answer yet?

```bash
dip --compact drucksache list --filter f.titel=Gebäudemodernisierungsgesetz --filter f.wahlperiode=21   # 7 hits
dip --compact drucksache-text get 290675        # Antwort 21/7982: no text field yet
dip --compact drucksache-text get 290149        # Kleine Anfrage 21/7563
dip --compact vorgang list --filter f.titel=Gebäude --filter f.wahlperiode=21                          # to link the law itself
```

The search found only Kleine Anfragen and answers, no bill. The law is filed as "Gesetz zur Änderung
des Gebäudeenergiegesetzes, …", and "Gebäudemodernisierungsgesetz" appears only in its abstract.
The newest hit, the government's answer of 10 Sep, has no extracted text yet. So the skill
digested the questions and pointed to the answer's PDF. It dropped URLs split across lines and the
printer's footer from the OCR text.

```
Drucksache 21/7563 (WP 21, 2026-08-13) — Kleine Anfrage, Fraktion BÜNDNIS 90/DIE GRÜNEN
Gesetzgebungsverfahren zum Gebäudemodernisierungsgesetz
Asked by Dr. Alaa Alhamwi, Dr. Julia Verlinden and 12 other Green MdBs (signed 6 Aug 2026)

Premise: the adopted GModG drops the 65-percent rule (§ 71 GEG), allows fossil heating beyond
2045, and adds a Grüngasquote for fuel suppliers from 2028 and a "Bio-Treppe" from 2029.
37 questions:
  • Q1–5, 10–12  contacts with the gas industry ("Die Gas- und Wasserstoffwirtschaft e. V.",
                 "Initiative Grüngasquote"): meetings, letters and drafting proposals to Minister
                 Katherina Reiche, state secretaries and BMWE officials since 6 May 2025
  • Q6–9, 13–14  who pushed dropping § 71 GEG, ending the 2045 fossil-boiler ban (§ 72 (4) GEG)
                 and the Bio-Treppe, and when
  • Q15–24       evidence base, controls and sanctions for Bio-Treppe and quota; biomethane
                 supply, cost forecasts, timetable for the quota
  • Q25–32       objections from the BMWSB in the Ressortabstimmung; constitutionality reviews
  • Q33–37       climate effect vs. the GEG 2026–2035, new gas heaters per year until 2045,
                 why their earlier Anfrage on gas costs for tenants took until 29 May to answer

Answer: Drucksache 21/7982 (2026-09-10, Bundesregierung, lead BMWE). Text not yet extracted:
  https://dserver.bundestag.de/btd/21/079/2107982.pdf
Procedure: Vorgang 338265 (Kleine Anfrage, Beantwortet)
The law: Vorgang 334923, GModG as Art. 1, Verkündet in BGBl I 2026, 226 (2026-07-28)
Source: https://dserver.bundestag.de/btd/21/075/2107563.pdf
```

Next steps offered: re-fetch `drucksache-text get 290675` once the answer's text is extracted, or run dip-procedure-tracker on Vorgang 334923.

## dip-member-dossier

> What does the Bundestag record say about Julia Klöckner: party, roles, and which terms?

```bash
dip --compact person list --filter f.wahlperiode=21                      # page 1 of 823 records, no match
dip --compact person list --filter f.wahlperiode=21 --cursor "$cursor"   # pages 2–10; hit on page 4, cursor unchanged after 10
dip --compact person get 224
```

`/person` has no name filter, so the skill paged the whole WP 21 list and matched `nachname`
itself. It read all 9 pages to rule out a second Klöckner. Party and function sit in top-level
`fraktion[]`/`funktion[]` arrays. `person_roles[]` here holds only term numbers and ministries,
with no role title.

```
Julia Klöckner — Person 224
Current (WP 21): MdB · CDU/CSU        (titel "Julia Klöckner, MdB, CDU/CSU")

Terms in the record: WP 15, 16, 17, 19, 20, 21 (not 18) · basisdatum 2002-11-13
Roles:
  • WP 21  MdB · CDU/CSU (role entry has no further detail)
  • WP 19  government role · Bundesministerium für Ernährung und Landwirtschaft
  • WP 17  government role · Bundesministerium für Ernährung, Landwirtschaft und Verbraucherschutz
  (no role entries for WP 15, 16 and 20)

Not in the record: the title of either ministry role, Wahlkreis, Bundesland, committees.
No Präsidium office in the record: none of the 823 WP 21 person records has the function
"Bundestagspräs." (4 have "Bundestagsvizepräs.").
Matched on nachname within WP 21: one hit in 823 records.
```

Next steps offered: a scan of WP 21 Drucksachen for "Klöckner" in `autoren_anzeige` (slow, loosely attributable).

## dip-procedure-tracker

> Where does the federal budget for 2027 stand in the Bundestag? Has there been a vote?

```bash
dip --compact vorgang list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=21   # 14 hits
dip --compact vorgangsposition list --filter f.vorgang=338317                         # 31 steps, one page
```

Most of the 14 hits were Entschließungsanträge on the 2025 and 2026 budgets. The skill kept
`vorgangstyp` Gesetzgebung and took the 2027 bill. 26 of the 31 steps belong to the first
reading, mostly one per Einzelplan, so the skill folded them into one line per sitting day. The
only `beschlussfassung` is a referral, not a vote. The Vorgang's abstract says
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

Notable:
  • Decision 2026-09-11: beschlusstenor "Überweisung" of 21/7300 and 21/7650. A referral, not a vote.
  • Lead committee: Haushaltsausschuss (HaushA); no co-advising committees listed.
  • Debated with the Finanzplan des Bundes 2026 bis 2030; 389 activities over four sittings.
  • Abstract figures: 555,436 Mrd Euro total, net borrowing up to 118,727 Mrd Euro,
    investment 56,272 Mrd Euro.
```

Next steps offered: dip-document-digest on the Schlussrunde in Plenarprotokoll 21/94 (pp. 11652–11673), or the Bundesrat committees' recommendations 450/1/26.
