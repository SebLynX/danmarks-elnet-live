# gridkort-api (Cloudflare Worker)

`worker.js` kører som Worker `gridkort-api` i Cloudflare-kontoen og svarer på
`https://api.gridkort.dk/elnet/now.json` med samme form som `data.json`.

- Henter `PowerSystemRightNow` og `DayAheadPrices` hos Energinet (uden Origin-header, så svaret ikke er tomt).
- Cacher den færdige måling i 60 s og priserne i 15 min pr. Cloudflare-sted. Fejl caches i 30 s.
- CORS kun for `*.gridkort.dk`, `seblynx.github.io`, `*.energinet.dk` og filer åbnet fra disken (`null`).
- Gratisplanen tillader 100.000 kald om dagen. Kortet kalder én gang i minuttet pr. åben fane.

Ændres filen her, skal den også udgives i Cloudflare (Workers & Pages → gridkort-api).
