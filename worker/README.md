# gridkort-api (Cloudflare Worker)

`worker.js` kører som Worker `gridkort-api` i Cloudflare-kontoen og svarer på
`https://api.gridkort.dk/elnet/now.json` med samme form som `data.json`, og på
`https://api.gridkort.dk/elnet/prices.json` med samme form som `prices.json`
(day-ahead-priserne for DK1 og DK2 i kvarterer, `DayAheadPriceDKK`, fra i dag kl. 00 til det
sidste offentliggjorte kvarter — normalt i morgen kl. 23:45). Kortet læser begge herfra først og
falder tilbage på filerne fra GitHub-kørslen, hvis workeren ikke svarer.

- Henter `PowerSystemRightNow` og `DayAheadPrices` hos Energinet (uden Origin-header, så svaret ikke er tomt).
- Cacher den færdige måling i 60 s og priserne i 1 time pr. Cloudflare-sted (priserne skifter én gang i døgnet).
  Fejl caches i 30 s. Et HTTP 429 sætter netop det datasæt på pause i hele den ventetid, Energinet
  angiver (`Retry-After` eller »Try again in X seconds« i svaret, ellers 15 min, højst 6 timer), og
  der sendes intet til det datasæt før pausen er slut. Energinet håndhæver nu ét kald pr. datasæt pr.
  opdateringsinterval, og kald inden for ventetiden kan forlænge spærringen.
- Afviste eller fejlende priser vælter ikke målingen: `now.json` bruger de sidst gode priser (eller ingen),
  og `prices.json` serverer den sidst gode serie, så længe den rækker ud over nu.
- `https://api.gridkort.dk/elnet/status` viser, hvilke datasæt dette Cloudflare-sted venter på, til hvornår
  og hvad Energinet svarede.
- `compactPrices()` er en kopi af funktionen i `prices.js`; `node --test` i repoets rod tjekker, at de to
  er ens, og kører workerens ruter under Node med en stub for Energinet og cachen (`test/worker.test.js`).
- CORS kun for `*.gridkort.dk`, `seblynx.github.io`, `*.energinet.dk` og filer åbnet fra disken (`null`).
- Gratisplanen tillader 100.000 kald om dagen. Kortet kalder én gang i minuttet pr. åben fane.

Ændres filen her, skal den også udgives i Cloudflare. Der er ingen CI for det: enten
Workers & Pages → gridkort-api → Edit code → indsæt `worker.js` → Deploy, eller fra en maskine
med `npx wrangler deploy worker/worker.js --name gridkort-api` og en API-token med
Workers Scripts: Edit (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Ruten
`api.gridkort.dk/*` er sat op i kontoen og følger med workeren.
