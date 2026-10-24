# gridkort-api (Cloudflare Worker)

`worker.js` kører som Worker `gridkort-api` i Cloudflare-kontoen og svarer på
`https://api.gridkort.dk/elnet/now.json` med samme form som `data.json`, og på
`https://api.gridkort.dk/elnet/prices.json` med samme form som `prices.json`
(day-ahead-priserne for DK1 og DK2 i kvarterer, fra i dag kl. 00 til det sidste
offentliggjorte kvarter).

- Henter `PowerSystemRightNow` og `DayAheadPrices` hos Energinet (uden Origin-header, så svaret ikke er tomt).
- Cacher den færdige måling i 60 s og priserne i 15 min pr. Cloudflare-sted. Fejl caches i 30 s.
- `compactPrices()` er en kopi af funktionen i `prices.js`; `node --test` i repoets rod tjekker at de to er ens.
- CORS kun for `*.gridkort.dk`, `seblynx.github.io`, `*.energinet.dk` og filer åbnet fra disken (`null`).
- Gratisplanen tillader 100.000 kald om dagen. Kortet kalder én gang i minuttet pr. åben fane.

Ændres filen her, skal den også udgives i Cloudflare (Workers & Pages → gridkort-api).
