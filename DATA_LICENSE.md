# Data license

> **This tool does not include, host, or redistribute any data.**
> `dip-bundestag-cli` is a *client*. It only accesses data served live by the
> **Deutscher Bundestag** via the DIP API. That data is the Bundestag's and is
> governed by **their** terms, summarized below. The license of this CLI's own
> source code is a separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Deutscher Bundestag (Parlamentsdokumentation) |
| **API / source** | `https://search.dip.bundestag.de/api/v1` · docs: https://dip.bundestag.de/über-dip/hilfe/api |
| **Data license** | **Custom — "Nutzungsbedingungen für DIP"** (Deutscher Bundestag, 27.02.2023). No SPDX/CC/`dl-de` identifier. |
| **License text** | https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf |
| **Attribution** | **Required** for any use beyond personal use. |
| **Commercial use** | Allowed (conditional — see below). |
| **Redistribution / modification** | API/machine-readable data may be broadly reused and processed, with source attribution and changes marked. |

## Attribution

Mandatory source label for any use beyond personal:

```
Quelle: Deutscher Bundestag – DIP (dip.bundestag.de).
```

- For quoted/reproduced official works, also cite the document type and number
  (e.g. `BT-Drs. 20/1234`, `BT-PlPr. 20/56`).
- Modifications must be marked as such.
- **For commercial use**, additionally include a note — with the link
  `dip.bundestag.de` — stating the data is available free of charge in DIP.

## Notes & caveats

- Two data classes: (a) the **PDF documents** of Drucksachen/Plenarprotokolle are
  *amtliche Werke* (§ 5 Abs. 2 UrhG) and **must not be altered** (§ 62 UrhG) —
  only recognizable excerpts with Quellenangabe; (b) the **API / machine-readable
  data** (what this CLI returns) "dürfen umfassend in jeglicher Form genutzt und
  weiterverarbeitet werden."
- **Misuse clause:** data may not be used in a distorting/defamatory context or
  alongside illegal, violence-glorifying, pornographic, racist or antisemitic content.
- No warranty for accuracy; the Bundestag warrants only its own rights, not the
  absence of third-party rights — clearing those is the user's responsibility.
- Abuse / server overload can lead to API-key blocking.

## Sources

- https://dip.bundestag.de/documents/nutzungsbedingungen_dip.pdf — official terms (27.02.2023)
- https://dip.bundestag.de/über-dip/hilfe/api — API help / key info

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
