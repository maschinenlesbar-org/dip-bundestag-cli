# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `dip-bundestag`, eines pro Skill: eine
Anfrage, die `dip`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `dip` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs können Sie
die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Jeder Skill holt zuerst einmal den API-Schlüssel und verwendet ihn bei jedem weiteren Aufruf:

```bash
dip obtain-key          # liest das Hilfedokument des DIP, prüft den Schlüssel, gibt ihn auf stdout aus
DIP_API_KEY="<der Schlüssel>" dip --compact …
```

`obtain-key` meldete auf stderr `Obtained the key from https://content.dip.bundestag.de/content-api/v1/content/help-api
and verified it against the live API.` Den Schlüssel selbst lassen die Beispiele weg.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [dip-document-digest](#dip-document-digest) · [dip-member-dossier](#dip-member-dossier) · [dip-procedure-tracker](#dip-procedure-tracker)

## dip-document-digest

> Die Grünen haben der Bundesregierung Fragen zur Entstehung des Gebäudemodernisierungsgesetzes gestellt. Was wurde gefragt, und gibt es schon eine Antwort?

```bash
dip --compact drucksache list --filter f.titel=Gebäudemodernisierungsgesetz --filter f.wahlperiode=21   # 7 Treffer
dip --compact drucksache-text get 290675        # Antwort 21/7982, mit dem Fragetext
dip --compact vorgang list --filter f.titel=Gebäude --filter f.wahlperiode=21 \
  --filter f.vorgangstyp=Gesetzgebung                                                                  # um das Gesetz selbst zu verknüpfen
```

Die Suche fand nur Kleine Anfragen und Antworten, keinen Gesetzentwurf: Das Gesetz ist als „Gesetz
zur Änderung des Gebäudeenergiegesetzes, …" erfasst. Der neueste Treffer ist die Antwort der
Bundesregierung vom 10.09.2026, und ihr Text ist inzwischen extrahiert. Weil eine Antwort jede
Frage in kleinerer Schrift wiederholt, hat der Skill Fragen und Antworten aus diesem einen Dokument
zusammengefasst. Über Zeilen umbrochene URLs und den Druckerei-Fußtext hat er aus dem OCR-Text
entfernt.

```
Drucksache 21/7982 (WP 21, 2026-09-10) – Antwort der Bundesregierung (BMWE)
auf die Kleine Anfrage 21/7563 von Dr. Alaa Alhamwi, Dr. Julia Verlinden, Hanna Steinmüller und
der Fraktion BÜNDNIS 90/DIE GRÜNEN: „Gesetzgebungsverfahren zum Gebäudemodernisierungsgesetz"

Ausgangslage der Fragen: Das verabschiedete GModG streicht die 65-Prozent-Regel (§ 71 GEG),
erlaubt fossile Heizungen über 2045 hinaus, führt ab 2028 eine Grüngasquote und ab 2029 eine
„Bio-Treppe" ein.

Beantwortet (37 Fragen):
  • Vorbemerkung: Der Kernbereich exekutiver Eigenverantwortung ist parlamentarisch nicht
    ausforschbar; Kontakte werden nicht vollständig erfasst, die Listen sind evtl. unvollständig.
  • F1–2 Treffen: BMin Reiche mit dem BDEW (Dohler, Andreae) am 23.07.2025 und mit Vorstand,
    Hauptgeschäftsführung und Lenkungskreisen des BDEW am 12.01.2026, beide „Wärmewende/GModG";
    PSt Rouenhoff mit ITGA-NRW/BTGA (20.08.2025) und dem BDI (16.03.2026). F3 Schriftverkehr mit
    der Gaswirtschaft: „Fehlanzeige".
  • F4–14 Entwürfe und wer was vorangetrieben hat: Die Stellungnahmen von Ländern und Verbänden
    stehen auf der Website des BMWE; der Koalitionsvertrag („Wir werden das Heizungsgesetz
    abschaffen") galt vom ersten Tag an; „Es steht jedem frei, für seine Anliegen zu werben";
    die meisten Fragen verweisen auf die Antwort zu F4.
  • F15–24 Bio-Treppe und Quote: Der Lieferant bestätigt die Bio-Treppe mit der Abrechnung,
    Verstöße sind bußgeldbewehrt; das Gesetz zur Grüngas-/Grünheizölquote ist „in der
    Vorbereitung" (kein Zeitplan); Prognosen zu Verfügbarkeit und Preisen streuen zu stark, um
    sie zu verwenden.
  • F25–32 Ressorts und Verfassung: BMWE und BMWSB haben einen gemeinsamen Referentenentwurf
    vorgelegt; die Bundesregierung hält das Gesetz für verfassungskonform.
  • F33–37 Klimawirkung: Der Bundestag hat das Gesetz am 10.07.2026 beschlossen, der Bundesrat
    hat keine Einwände erhoben; eine Abschätzung der Klimawirkung „wird derzeit vorbereitet";
    keine Prognose neuer Gasheizungen; die späte Antwort auf 21/6229 lag an Ressortabstimmungen
    und Recherche.

Vorgang: 338265 (Kleine Anfrage)
Das Gesetz: Vorgang 334923, Verkündet in BGBl I 2026, 226 (2026-07-28)
Quelle: https://dserver.bundestag.de/btd/21/079/2107982.pdf
```

Als Nächstes angeboten: die vollständigen Antworten zu F1–2 als Tabelle, oder dip-procedure-tracker für Vorgang 334923.

## dip-member-dossier

> Was steht in den Bundestagsdaten über Julia Klöckner: Fraktion, Rollen, Wahlperioden?

```bash
dip --compact person list --filter f.person=Klöckner --filter f.wahlperiode=21   # 1 Treffer: ID 224
dip --compact person get 224
```

`f.person` fand sie mit einer Anfrage über den Nachnamen, Blättern war nicht nötig. Fraktion und
Funktion stehen in den Arrays `fraktion[]`/`funktion[]` auf oberster Ebene; `person_roles[]`
enthält nur Wahlperioden und Ressorts, keine Rollenbezeichnung.

```
Julia Klöckner – Person 224
Aktuell (WP 21): MdB · CDU/CSU        (titel „Julia Klöckner, MdB, CDU/CSU")

Wahlperioden im Datensatz: WP 15, 16, 17, 19, 20, 21 (nicht 18) · basisdatum 2002-11-13 · zuletzt 2026-09-10
Frühere Rollen:
  • WP 19  Ressort Bundesministerium für Ernährung und Landwirtschaft (Rollentitel nicht im Datensatz)
  • WP 17  Ressort Bundesministerium für Ernährung, Landwirtschaft und Verbraucherschutz
  • WP 21  ein Rolleneintrag nur mit ihrem Namen, ohne weitere Angaben
  (keine Rolleneinträge für WP 15, 16 und 20)

Nicht im Datensatz: Bezeichnung der beiden Ressortrollen, Wahlkreis, Bundesland, Ausschüsse, und
kein Präsidiumsamt (ihre aktuelle Funktion ist MdB).
```

Als Nächstes angeboten: ihre Aktivitäten in der WP 21 (`aktivitaet list --filter f.person_id=224 --filter f.wahlperiode=21`, beim Blättern beide Filter wiederholt).

## dip-procedure-tracker

> Wie weit ist der Bundeshaushalt 2027 im Bundestag? Wurde schon abgestimmt?

```bash
dip --compact vorgang list --filter f.titel=Haushaltsgesetz --filter f.wahlperiode=21   # 14 Treffer
dip --compact vorgangsposition list --filter f.vorgang=338317                         # 33 Schritte, eine Seite
```

Die meisten der 14 Treffer waren Entschließungsanträge zu den Haushalten 2025 und 2026. Der Skill
behielt den `vorgangstyp` Gesetzgebung und nahm den Entwurf für 2027. Alle 33 Schritte passen auf
eine Seite (`numFound` 33), ein Aufruf mit `--cursor` war nicht nötig. 26 Schritte gehören zur
ersten Beratung, meist einer je Einzelplan; der Skill hat sie zu einer Zeile pro Sitzungstag
zusammengefasst. Keine der beiden `beschlussfassung`en ist eine Abstimmung über das Gesetz: Die
eine ist die Überweisung, die andere die Stellungnahme des Bundesrates. Das Abstract des Vorgangs
spricht von „Bundeshaushaltsplans 2026", obwohl alles andere 2027 betrifft – die Zahlen daraus
sind deshalb mit Vorbehalt zitiert.

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
  2026-09-25  BR  1. Durchgang (PlPr 1068): Stellungnahme nach Art. 110 (3) GG → Beschlussdrucksache 450/26(B)

Wichtig:
  • Beschluss 2026-09-11: beschlusstenor „Überweisung" von 21/7300 und 21/7650 – keine Abstimmung.
  • Beschluss 2026-09-25: Stellungnahme des Bundesrates im ersten Durchgang – keine Abstimmung.
  • Federführender Ausschuss: Haushaltsausschuss (HaushA); keine mitberatenden Ausschüsse erfasst.
  • Beraten zusammen mit dem Finanzplan des Bundes 2026 bis 2030 und dem Haushaltsbegleitgesetz
    2027; 397 Aktivitäten in den vier Sitzungen und der Bundesratssitzung.
  • Zahlen aus dem Abstract: 555,436 Mrd Euro gesamt, Nettokreditaufnahme bis 118,727 Mrd Euro,
    Investitionen 56,272 Mrd Euro.
```

Als Nächstes angeboten: dip-document-digest für die Schlussrunde im Plenarprotokoll 21/94 (S. 11652–11673) oder die Stellungnahme des Bundesrates 450/26(B).
