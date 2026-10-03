# Börsencockpit

Marktlage, zwölf Kennzahlen, Smart/Dumb Money und die neuesten Videos deiner YouTube-Kanäle auf einen Blick.

**Seite:** https://tec7p.github.io/boersencockpit/

## So funktioniert es

Alle 15 Minuten holt GitHub Actions (`.github/workflows/update.yml`) die Daten mit `scripts/fetch_data.py`,
schreibt sie in `data.json` und veröffentlicht die Seite aus `web/` neu. Fällt eine Quelle aus,
bleibt der letzte gute Wert stehen und wird mit „alt“ markiert.

| Bereich | Quelle |
|---|---|
| DAX, S&P 500, Nasdaq 100, VIX, US 10 J., EUR/USD, Gold, Brent, Bitcoin | Yahoo Finance (Ersatz: FRED) |
| Bund 10 J. | Bundesbank (Ersatz: EZB) |
| Fear & Greed | CNN, alternative.me |
| Smart / Dumb Money | CFTC Commitments of Traders, E-Mini S&P 500 |
| Videos | YouTube-Kanal-Feeds |

## Kanäle und Magazine ändern

In `config.json` die Listen `channels` (Name und YouTube-Handle ohne @) und `magazines` anpassen.
Nach dem Speichern wird die Seite automatisch neu gebaut.

## Lokal testen

```
mkdir -p site && cp web/* site/
python3 scripts/fetch_data.py --out site/data.json
python3 -m http.server -d site 8000
```

Kein Anlagerat.
