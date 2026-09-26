# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`dip-bundestag-cli` verwendet werden. Die Fachsprache des DIP ist Deutsch; dieses
Glossar nennt neben dem deutschen Originalbegriff den in CLI und API verwendeten
englischen Begriff (sofern es einen gibt).

> **Übersetzungstabelle.** Die CLI behält die deutschen Ressourcennamen bei (es
> sind die Pfade der API selbst); ihre englische Bedeutung steht hier:
>
> | Deutsch | Englisch |
> | --- | --- |
> | Vorgang | procedure / legislative process |
> | Vorgangsposition | procedure step / position within a procedure |
> | Drucksache | printed paper |
> | Plenarprotokoll | plenary protocol (minutes) |
> | Aktivität | activity |
> | Person | person (member / actor) |
> | Wahlperiode | electoral term / legislative period |
> | Bundestag | the federal parliament |
> | Bundesrat | the federal council (states' chamber) |

---

## DIP

**DIP – Dokumentations- und Informationssystem für Parlamentsmaterialien.**
Der Katalog des Bundestages mit Daten zu parlamentarischen Abläufen: wer was
eingebracht hat, die zugehörigen Dokumente, die Plenardebatten und die handelnden
Personen. Im Browser unter [`dip.bundestag.de`](https://dip.bundestag.de); die
maschinenlesbare API, die dieses Tool kapselt, liegt unter
`search.dip.bundestag.de/api/v1`.

**Bundestag.** Das deutsche Bundesparlament (die gewählte Kammer). Der **Bundesrat**
ist die Kammer, in der die sechzehn Länder vertreten sind. Das DIP enthält
Materialien beider Organe.

**API-Schlüssel.** Das DIP verlangt einen API-Schlüssel, der als HTTP-Header
`Authorization: ApiKey <key>` gesendet wird. Der Schlüssel ist **nicht mitgeliefert** –
geben Sie ihn über `--api-key` oder die Umgebungsvariable `DIP_API_KEY` an; andernfalls
entfällt der Header und die API antwortet mit `401`. Der Bundestag veröffentlicht einen
öffentlichen Schlüssel auf seiner
[Hilfeseite zur DIP-API](https://dip.bundestag.de/über-dip/hilfe/api) (dort 2026 als
gültig bis Ende Mai 2027 angegeben); einen persönlichen Schlüssel erhalten Sie auf
Anfrage bei `parlamentsdokumentation@bundestag.de`. Der CLI-Befehl `obtain-key` liest
den Schlüssel dieser Seite aus dem JSON-Dokument, das der Content-Dienst des DIP
dahinter ausliefert, weicht notfalls auf das bundesAPI-README aus und **prüft den
Schlüssel vor der Ausgabe gegen die Live-API** – er schlägt also fehl, statt einen von
der API abgelehnten Schlüssel auszugeben.

---

## Ressourcen (Endpoints)

Jede Ressource steht unter `/api/v1/<resource>` mit einem Listen-Endpoint
(`/<resource>`) und einem Einzel-Endpoint (`/<resource>/<id>`) bereit. Die CLI bildet
das als `<resource> list` und `<resource> get <id>` ab.

**Vorgang.** Ein Gesetzgebungs- oder parlamentarischer *Prozess* – z. B. ein
Gesetzentwurf, ein Antrag oder eine Anfrage –, der von der Einbringung bis zum
Abschluss verfolgt wird. Die zentrale Einheit, die Dokumente, Aktivitäten und Personen
miteinander verbindet. CLI: `vorgang`. Client: `client.vorgaenge`.

**Vorgangsposition.** Ein einzelner *Schritt* innerhalb eines Vorgangs – ein Ereignis
in seinem Verlauf (z. B. eine erste Lesung, eine Ausschussüberweisung, eine
Abstimmung). Ein Vorgang hat viele Vorgangspositionen. CLI: `vorgangsposition`.
Client: `client.vorgangspositionen`.

**Drucksache.** Ein förmliches parlamentarisches *Dokument* – Gesetzentwürfe, Anträge,
Berichte, Antworten auf Anfragen usw. –, identifiziert durch eine Drucksachennummer
innerhalb einer Wahlperiode. CLI: `drucksache`. Client: `client.drucksachen`.

**Drucksache-Text.** Dieselben Drucksachen, jedoch mit dem **extrahierten Volltext**
des Dokuments in der Antwort (ein eigener, umfangreicherer Endpoint).
CLI: `drucksache-text`. Client: `client.drucksacheText`.

**Plenarprotokoll.** Das stenografische *Protokoll* einer Plenarsitzung des Bundestages
oder des Bundesrates. CLI: `plenarprotokoll`. Client: `client.plenarprotokolle`.

**Plenarprotokoll-Text.** Die Plenarprotokolle mit dem **extrahierten Volltext** des
Protokolls. CLI: `plenarprotokoll-text`. Client: `client.plenarprotokollText`.

**Aktivität.** Eine erfasste *Handlung* einer Person innerhalb eines Vorgangs – z. B.
eine Rede, eine Frage, eine Unterschrift unter einem Antrag. Verknüpft eine Person mit
einem Vorgang. CLI: `aktivitaet`. Client: `client.aktivitaeten`.

**Person.** Eine in den Materialien vorkommende *Person* – typischerweise ein:e
Abgeordnete:r, aber auch andere Akteure. CLI: `person`. Client: `client.personen`.

---

## Kennungen, Filter & Paginierung

**id.** Jedes Ressourcendokument hat eine numerische `id`, die der `get`-Endpoint
(`drucksache get 123456`) und der Filter `f.id` verwenden. Das CLI-Flag `--id` ist eine
Kurzform für `f.id` und kann mehrfach angegeben werden.

**`f.*`-Filter.** DIP-Filter sind Query-Parameter mit dem Präfix `f.`, z. B. `f.titel`
(Titel), `f.id`, `f.wahlperiode`, `f.datum.start` / `f.datum.end` (Datumsbereich),
`f.vorgangstyp`, `f.dokumentart`, `f.aktualisiert.start` (Zeitraum der letzten
Aktualisierung). Die CLI reicht sie über `--filter key=value` (mehrfach angebbar)
unverändert weiter; nur das erste `=` trennt Schlüssel und Wert, ein Wert darf also
selbst `=` enthalten. Wird derselbe Schlüssel wiederholt, werden wiederholte
Query-Schlüssel gesendet (`?f.id=1&f.id=2`), die das DIP als ODER-Menge behandelt.

**cursor.** Die Listen-Endpoints des DIP sind **cursorbasiert paginiert**. Eine
Listenantwort enthält einen `cursor`; geben Sie ihn über `--cursor` (CLI) oder
`{ cursor }` (Bibliothek) zurück, um die nächste Seite abzurufen. Der Cursor ist
opak – behandeln Sie ihn als Token, nicht als Zahl. Ändert sich der zurückgegebene
Cursor nicht mehr, ist das Ende erreicht.

**numFound.** Die Gesamtzahl der Dokumente, die zu einer Listenabfrage passen (über
alle Seiten hinweg); sie steht in der Listenhülle neben den `documents` der aktuellen
Seite.

**documents.** Das Array der Ressourcendokumente auf der aktuellen Seite einer
Listenantwort. Jedes wird als unverändertes rohes `JsonObject` bereitgestellt (die
Nutzdaten je Ressource sind umfangreich und ressourcenspezifisch und werden daher
nicht auf typisierte Felder eingeschränkt).

**Wahlperiode.** Die nummerierte Legislaturperiode des Bundestages (z. B. die
20. Wahlperiode). Die meisten Ressourcen haben ein Feld `wahlperiode` und lassen sich
mit `f.wahlperiode` filtern; Dokumentnummern gelten jeweils innerhalb einer
Wahlperiode.

**Vorgangstyp.** Die Einordnung eines Vorgangs (z. B. *Gesetzgebung*, *Antrag*,
*Kleine Anfrage*). Filterbar über `f.vorgangstyp`.

**Dokumentart.** Ob ein Dokument eine *Drucksache* oder ein *Plenarprotokoll* ist.
Filterbar über `f.dokumentart` bei `vorgang`, `vorgangsposition` und `aktivitaet`. Die
Art einer Drucksache (Antrag, Gesetzentwurf, Antwort, …) steht in `drucksachetyp` und
ist über `f.drucksachetyp` filterbar.

**Datum.** Das Datum, auf das ein Dokument bzw. eine Aktivität datiert ist. Die
Filterung nach Datumsbereich nutzt `f.datum.start` und `f.datum.end` (ISO
`YYYY-MM-DD`). Der Query-Builder serialisiert `Date`-Werte zu vollständigen
ISO-8601-Zeichenketten.

**Zuordnung.** Manche Ressourcen lassen sich nach Kammer bzw. Zuordnung filtern
(`f.zuordnung`), um Materialien des Bundestages (`BT`) von denen des Bundesrates
(`BR`) zu unterscheiden.

---

## API-Verhalten & Fehler

**Basis-URL.** Standardmäßig `https://search.dip.bundestag.de`; überschreibbar mit
`--base-url` (CLI) oder `baseUrl` (Bibliothek). Alle Ressourcenpfade liegen unter
`/api/v1`.

**Rate-Limiting.** Das DIP begrenzt die Anfragerate; bei Überschreitung antwortet die
API mit **429**. Der Client wiederholt **429** und **503** automatisch
(`--max-retries`, 0–10, Standard 2) und wartet dabei das `Retry-After` der Antwort ab
(bis 30 s; ein längeres wird nicht wiederholt), sonst mit linearem Backoff.

**Entfernen von Zugangsdaten bei Weiterleitungen.** Der Header `Authorization` (sowie
`X-API-Key` / `Cookie`) wird bei jeder Weiterleitung auf einen anderen Origin entfernt,
sodass der API-Schlüssel nie an einen anderen Host als den angesteuerten gelangt.
Weiterleitungen innerhalb desselben Origins behalten ihn.

**Fehlertypen.** [`errors.ts`](src/client/errors.ts): `DipApiError` (Nicht-2xx-Antwort,
enthält `status`/`detail`/`url`/`method`/`body` sowie `isRetryable` für 429/503),
`DipNetworkError` (Transportfehler/Timeout), `DipParseError` (ungültiges JSON) und
`DipUsageError` (ein CLI-Bedienfehler wie eine leere `get`-ID), alle abgeleitet von
`DipError`. Exit-Codes: `0` bei Erfolg, `2` bei Bedienfehlern, `4` bei `404`, `1` bei
jedem anderen Laufzeitfehler (auch bei `401`, wenn der Schlüssel fehlt oder abgelaufen
ist).

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `DipClient`, Ressourcengruppen, die Request-Engine, Transport, Retry/Backoff,
> Fehlertypen, Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
