# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `dip-bundestag`, eines pro Skill: eine
Anfrage, die `dip`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `dip` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [dip-document-digest](#dip-document-digest) · [dip-member-dossier](#dip-member-dossier) · [dip-procedure-tracker](#dip-procedure-tracker)

## dip-document-digest

> Die Grünen haben der Bundesregierung Fragen zur Entstehung des Gebäudemodernisierungsgesetzes gestellt. Was wurde gefragt, und gibt es schon eine Antwort?

```bash
dip --compact drucksache list --filter f.titel=Gebäudemodernisierungsgesetz --filter f.wahlperiode=21   # 7 Treffer
dip --compact drucksache-text get 290675        # Antwort 21/7982: noch kein text-Feld
dip --compact drucksache-text get 290149        # Kleine Anfrage 21/7563
dip --compact vorgang list --filter f.titel=Gebäude --filter f.wahlperiode=21                          # um das Gesetz selbst zu verknüpfen
```

Die Suche fand nur Kleine Anfragen und Antworten, keinen Gesetzentwurf. Das Gesetz ist als
„Gesetz zur Änderung des Gebäudeenergiegesetzes, …" erfasst; „Gebäudemodernisierungsgesetz" steht
nur im Abstract. Der neueste Treffer, die Antwort der Bundesregierung vom 10.09.2026, hat noch
keinen extrahierten Text. Deshalb hat der Skill die Fragen zusammengefasst und für die Antwort auf
das PDF verwiesen. Über Zeilen umbrochene URLs und den Druckerei-Fußtext hat er aus dem OCR-Text
entfernt.

```
Drucksache 21/7563 (WP 21, 2026-08-13) – Kleine Anfrage, Fraktion BÜNDNIS 90/DIE GRÜNEN
Gesetzgebungsverfahren zum Gebäudemodernisierungsgesetz
Fragesteller: Dr. Alaa Alhamwi, Dr. Julia Verlinden und 12 weitere grüne MdBs (datiert 06.08.2026)

Ausgangslage: Das verabschiedete GModG streicht die 65-Prozent-Regel (§ 71 GEG), erlaubt fossile
Heizungen über 2045 hinaus und führt ab 2028 eine Grüngasquote für Inverkehrbringer sowie ab 2029
eine „Bio-Treppe" ein.
37 Fragen:
  • F1–5, 10–12  Kontakte zur Gaswirtschaft („Die Gas- und Wasserstoffwirtschaft e. V.",
                 „Initiative Grüngasquote"): Treffen, Schriftverkehr und Formulierungsvorschläge an
                 Ministerin Katherina Reiche, Staatssekretäre und leitende BMWE-Beamte seit 06.05.2025
  • F6–9, 13–14  wer die Streichung von § 71 GEG, das Ende des Betriebsverbots für fossile Kessel
                 ab 2045 (§ 72 (4) GEG) und die Bio-Treppe vorangetrieben hat, und wann
  • F15–24       fachliche Grundlage, Kontrolle und Sanktionen für Bio-Treppe und Quote;
                 Biomethan-Verfügbarkeit, Kostenprognosen, Zeitplan für die Quote
  • F25–32       Einwände des BMWSB in der Ressortabstimmung; Prüfung der Verfassungsmäßigkeit
  • F33–37       Klimawirkung gegenüber dem GEG 2026–2035, neue Gasheizungen pro Jahr bis 2045,
                 warum die Antwort auf ihre frühere Anfrage zu Gaskosten für Mietende erst am
                 29.05.2026 kam

Antwort: Drucksache 21/7982 (2026-09-10, Bundesregierung, federführend BMWE). Text noch nicht
  extrahiert: https://dserver.bundestag.de/btd/21/079/2107982.pdf
Vorgang: 338265 (Kleine Anfrage, Beantwortet)
Das Gesetz: Vorgang 334923, GModG als Art. 1, Verkündet in BGBl I 2026, 226 (2026-07-28)
Quelle: https://dserver.bundestag.de/btd/21/075/2107563.pdf
```

Als Nächstes angeboten: `drucksache-text get 290675` erneut abrufen, sobald der Antworttext extrahiert ist, oder dip-procedure-tracker für Vorgang 334923.

## dip-member-dossier

> Was steht in den Bundestagsdaten über Julia Klöckner: Fraktion, Rollen, Wahlperioden?

```bash
dip --compact person list --filter f.wahlperiode=21                      # Seite 1 von 823 Datensätzen, kein Treffer
dip --compact person list --filter f.wahlperiode=21 --cursor "$cursor"   # Seiten 2–10; Treffer auf Seite 4, Cursor nach 10 unverändert
dip --compact person get 224
```

`/person` hat keinen Namensfilter. Deshalb hat der Skill die gesamte Liste der WP 21 durchgeblättert
und selbst auf `nachname` abgeglichen. Er las alle 9 Seiten, um eine zweite Klöckner
auszuschließen. Fraktion und Funktion stehen in den Arrays `fraktion[]`/`funktion[]` auf oberster
Ebene; `person_roles[]` enthält hier nur Wahlperioden und Ressorts, keine Rollenbezeichnung.

```
Julia Klöckner – Person 224
Aktuell (WP 21): MdB · CDU/CSU        (titel „Julia Klöckner, MdB, CDU/CSU")

Wahlperioden im Datensatz: WP 15, 16, 17, 19, 20, 21 (nicht 18) · basisdatum 2002-11-13
Rollen:
  • WP 21  MdB · CDU/CSU (Rolleneintrag ohne weitere Angaben)
  • WP 19  Regierungsrolle · Bundesministerium für Ernährung und Landwirtschaft
  • WP 17  Regierungsrolle · Bundesministerium für Ernährung, Landwirtschaft und Verbraucherschutz
  (keine Rolleneinträge für WP 15, 16 und 20)

Nicht im Datensatz: Bezeichnung der beiden Ressortrollen, Wahlkreis, Bundesland, Ausschüsse.
Kein Präsidiumsamt im Datensatz: Keiner der 823 Personendatensätze der WP 21 hat die Funktion
„Bundestagspräs." (4 haben „Bundestagsvizepräs.").
Abgleich über nachname innerhalb der WP 21: ein Treffer in 823 Datensätzen.
```

Als Nächstes angeboten: eine Suche in den Drucksachen der WP 21 nach „Klöckner" in `autoren_anzeige` (langsam, Zuordnung nur ungefähr).

## dip-procedure-tracker

> Wie weit ist der Bundeshaushalt 2027 im Bundestag? Wurde schon abgestimmt?

```bash
dip --compact vorgang list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=21   # 14 Treffer
dip --compact vorgangsposition list --filter f.vorgang=338317                         # 31 Schritte, eine Seite
```

Die meisten der 14 Treffer waren Entschließungsanträge zu den Haushalten 2025 und 2026. Der Skill
behielt den `vorgangstyp` Gesetzgebung und nahm den Entwurf für 2027. 26 der 31 Schritte gehören
zur ersten Beratung, meist einer je Einzelplan; der Skill hat sie zu einer Zeile pro Sitzungstag
zusammengefasst. Die einzige `beschlussfassung` ist eine Überweisung, keine Abstimmung. Das
Abstract des Vorgangs spricht von „Bundeshaushaltsplans 2026", obwohl alles andere 2027 betrifft –
die Zahlen daraus sind deshalb mit Vorbehalt zitiert.

```
Haushaltsgesetz 2027 (HG 2027) – WP 21 · Gesetzgebung · Vorgang 338317
Status: Überwiesen. Erste Beratung abgeschlossen, jetzt im Haushaltsausschuss; noch keine Schlussabstimmung
Initiative: Bundesregierung (federführend: Bundesministerium der Finanzen)
Zustimmung Bundesrat: „Nein, laut Gesetzentwurf (Drs 450/26)"

Ablauf:
  2026-08-14  BT  Gesetzentwurf (Drs 21/7300)
  2026-08-14  BR  Gesetzentwurf (Drs 450/26, Berichtigung zu450/26) → Finanzausschuss (federführend)
  2026-08-21  BT  Unterrichtung (Drs 21/7650): Anlage nach § 28 (3) BHO für Epl 03, 19, 20
  2026-09-08  BT  1. Beratung (PlPr 21/91): Einbringung, Allgemeine Finanzdebatte (Epl 08, 20, 32, 60),
                  Epl 12, 16, 24, 09
  2026-09-09  BT  1. Beratung (PlPr 21/92): Epl 04, 05, 14, 23
  2026-09-10  BT  1. Beratung (PlPr 21/93): Epl 06, 07, 10, 17, 25, 15
  2026-09-11  BT  1. Beratung (PlPr 21/94): Epl 11, 30, Schlussrunde → Überweisung (S. 11673C)
  2026-09-11  BR  Empfehlungen der Ausschüsse (Drs 450/1/26): Stellungnahme

Wichtig:
  • Beschluss 2026-09-11: beschlusstenor „Überweisung" von 21/7300 und 21/7650 – keine Abstimmung.
  • Federführender Ausschuss: Haushaltsausschuss (HaushA); keine mitberatenden Ausschüsse erfasst.
  • Beraten zusammen mit dem Finanzplan des Bundes 2026 bis 2030; 389 Aktivitäten in vier Sitzungen.
  • Zahlen aus dem Abstract: 555,436 Mrd Euro gesamt, Nettokreditaufnahme bis 118,727 Mrd Euro,
    Investitionen 56,272 Mrd Euro.
```

Als Nächstes angeboten: dip-document-digest für die Schlussrunde im Plenarprotokoll 21/94 (S. 11652–11673) oder die Empfehlungen der Bundesratsausschüsse 450/1/26.
