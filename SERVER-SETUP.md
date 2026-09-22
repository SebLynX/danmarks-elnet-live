# Til den serveransvarlige

Kortet er én statisk HTML-fil. Den har ingen backend, ingen API-nøgle og ingen
runtime-dependencies. Det eneste den mangler for at vise live-tal er en kilde
til friske data på **samme origin** som siden selv.

## Hvorfor det ikke bare virker

`api.energidataservice.dk` svarer med et **tomt 200** på enhver forespørgsel der
bærer en `Origin`-header — altså alt hvad en browser sender, uanset hvilket
domæne siden ligger på. Verificeret igen 22-09-2026:

```
curl -s -o /dev/null -w '%{size_download}\n' \
  "https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=1"
674                      <- uden Origin: rigtige data

curl -s -o /dev/null -w '%{size_download}\n' -H "Origin: https://example.com" \
  "https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=1"
0                        <- med Origin: tomt svar
```

Det er ikke et udfald og ikke noget der retter sig selv — det ligner en bevidst
spærring i Energinets eget edge-lag. Kort sagt: **browseren kan aldrig selv nå
API'et, men alt der ikke er en browser kan.**

Der er derfor to veje. Vælg den der passer til hostingen.

---

## Mulighed A — reverse proxy (bedst, hvis der er en rigtig webserver)

Send `/api/` videre til API'et. Så opdaterer kortet sig selv **hvert minut**,
der skal ikke skrives filer, og der er ingen nøgle at passe på eller forny.

Kortet bruger automatisk `/api/` når det serveres over http(s) — der skal intet
ændres i HTML-filen.

**nginx**

```nginx
location /api/ {
    proxy_pass https://api.energidataservice.dk/;
    proxy_set_header Host api.energidataservice.dk;
    proxy_set_header Origin "";      # vigtigt: uden denne kommer der tomme svar
}
```

**IIS** — ARR/URL Rewrite til `https://api.energidataservice.dk/{R:1}`, og fjern
eller tøm `Origin` på den udgående forespørgsel.

**Azure Front Door / CDN** — en route `/api/*` med
`api.energidataservice.dk` som origin.

Test bagefter:

```
curl -s -o /dev/null -w '%{size_download}\n' "https://DIN-HOST/api/dataset/PowerSystemRightNow?limit=1"
```

Et tal over 0 betyder det virker. Får du 0, sendes `Origin` stadig med videre.

---

## Mulighed B — cron-job (hvis der ikke er en proxy)

`poll.js` henter tallene og skriver en `data.json` på ca. 470 bytes. Læg den
**ved siden af HTML-filen**, så læser siden den fra sin egen mappe.

```
node poll.js /sti/til/webroot/data.json
```

Krav: **Node.js 18 eller nyere** (scriptet bruger indbygget `fetch`). Ingen
`npm install`, ingen pakker — filen er selvstændig.

**crontab** — hvert 5. minut:

```
*/5 * * * * cd /sti/til/webroot && /usr/bin/node /sti/til/poll.js /sti/til/webroot/data.json >> /var/log/elnet-poll.log 2>&1
```

**Windows Task Scheduler** — samme kommando, interval efter behov.

Scriptet returnerer exit-kode 1 hvis noget fejler, og skriver i så fald **ikke**
filen — så et mislykket kald efterlader den forrige `data.json` urørt i stedet
for at lægge noget halvt op. Kortet afviser af sig selv data ældre end 3 timer
og falder tilbage til den indlejrede 30-dages historik i stedet for at kalde
gamle tal for live.

Hyppighed er frit valg. Kilden opdateres hvert minut; hvert 5.-15. minut er
rigeligt til en demonstration.

**Cache:** sørg for at `data.json` ikke caches, ellers ser folk gårsdagens tal.
`Cache-Control: no-store` på den ene fil er nok. Siden cache-buster i forvejen
sin egen forespørgsel, men et mellemliggende CDN kan stadig nå at gemme den.

---

## Filer

| Fil | Hvor | Hvad |
|---|---|---|
| `index.html` | webroot | Selve kortet. Én fil, ingen dependencies |
| `data.json` | samme mappe som `index.html` | Skrives af `poll.js`. Kun ved mulighed B |
| `poll.js` | hvor som helst på serveren | Selve scriptet. Kun ved mulighed B |

Ved mulighed A skal kun `index.html` uploades.

## Sådan ser man at det virker

Åbn siden. Øverst til højre skal der stå **LIVE** med et grønt punkt, og feltet
ved siden af skal vise hvor gammel målingen er ("måling 2 min gammel").

Står der **OFFLINE**, skriver banneret selv hvad der mangler — om `data.json`
ikke findes, er for gammel, eller ikke kan læses.

Data: Energinet Energi Data Service (åbne data). Positioner: OpenStreetMap (ODbL).
