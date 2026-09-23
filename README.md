# Danmarks Elnet — live

Et 3D-kort over det danske elsystem: produktion, CO₂, udveksling med nabolandene og
day-ahead-priser. Tallene opdaterer sig selv.

**Se kortet her: https://seblynx.github.io/danmarks-elnet-live/**

Kortet er én HTML-fil. Ingen backend, ingen API-nøgle, ingen installation. Ved siden af
filen ligger to datafiler: `data.json` på ca. 470 bytes med det nyeste måleøjeblik, og
`hist.json` på ca. 70 KB med de sidste 30 dages historik i timeopløsning — den der
tegner tidslinjen under kortet.

Dette repo indeholder det færdigbyggede kort. Selve kildekoden ligger i et privat repo.

---

## Tallene opdaterer sig selv

`.github/workflows/update-data.yml` er sat til at køre hvert 15. minut. Hver kørsel gør
fire ting:

1. Henter `PowerSystemRightNow` og `DayAheadPrices` fra Energinet Energi Data Service.
2. Tjekker at alle felter er tal, og at tidsstemplet ser rigtigt ud.
3. Skriver resultatet til `data.json`.
4. Committer filen tilbage til repoet, men kun hvis tallene har ændret sig.

**Tidslinjen fornyes for sig.** Er `hist.json` mere end 6 timer gammel, henter kørslen
også de sidste 30 dage forfra hos Energinet og lægger dem ved siden af. Historikken
bygges altså ikke af vores egne målinger — den hentes komplet fra kilden hver gang. Det
er med vilje: kørslerne springer tider over (se nedenfor), og en selvbygget historik
ville få huller præcis der hvor en kørsel udeblev. Hentes den forfra, er rækken hel og i
timeopløsning uanset hvor ofte jobbet får lov at køre.

GitHub Pages serverer begge filer fra samme mappe som kortet, så browseren henter dem
fra sin egen adresse.

Fejler hentningen, stopper kørslen med en fejl og skriver **ikke** filen. Så bliver den
forrige `data.json` liggende urørt i stedet for at blive erstattet af noget halvt.

**Hvor gamle er tallene i praksis? Regn med timer, ikke minutter.** Tidsplanen beder om
hvert 15. minut, men GitHub leverer kun en lille del af de bestilte tider. Målt på dette
repo: 5 kørsler ud af ca. 62 bestilte, med mellemrum på 2 til 5 timer.

Det er ikke en fejl i opsætningen, og det kan ikke rettes herfra. GitHub skriver selv at
planlagte kørsler forsinkes når der er travlt, og at *"some queued jobs may be dropped"*
— droppes, ikke sættes i kø. Til sammenligning blev to fremmede offentlige repoer målt:
et seks år gammelt repo med præcis samme tidsplan får samme andel, og et repo der beder
om hvert 5. minut får samme mellemrum. Hverken alder, aktivitet eller en tættere tidsplan
ændrer noget.

Kortet viser selv alderen ved siden af LIVE-mærket, så man aldrig er i tvivl.

Er `data.json` mere end 3 timer gammel, bliver den afvist. Kortet skifter til **OFFLINE**
og viser historikken i stedet. Hellere ærligt OFFLINE end gamle tal med et LIVE-mærkat
på. Med mellemrum på op til 5 timer sker det jævnligt — og det er den rigtige opførsel,
ikke en fejl.

**Skal tallene være friske hver 15. minut**, kan det ikke lade sig gøre med GitHubs
gratis tidsplan. Det kræver enten en reverse proxy på den server der viser kortet (så
browseren selv kalder API'et hvert minut), eller en udefrakommende tidsplan der starter
workflowet. Se `SERVER-SETUP.md`.

Repoet er offentligt, og GitHub Actions er gratis uden minutgrænse for offentlige repos.
En kørsel tager ca. et minut.

---

## Hvorfor der skal et script til

Det korte svar: **browseren kan ikke selv hente data fra API'et. Et script kan.**

`api.energidataservice.dk` svarer med et **tomt 200** på enhver forespørgsel, der bærer en
`Origin`-header. Det gør alt, hvad en browser sender — uanset hvilket domæne siden ligger
på, og også `null` fra en fil åbnet lokalt. Forespørgsler uden `Origin` får fulde data.

Verificeret igen 22-09-2026:

```
curl -s -o /dev/null -w '%{size_download}\n' \
  "https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=1"
674                      <- uden Origin: rigtige data

curl -s -o /dev/null -w '%{size_download}\n' -H "Origin: https://example.com" \
  "https://api.energidataservice.dk/dataset/PowerSystemRightNow?limit=1"
0                        <- med Origin: tomt svar
```

Det er ikke et udfald, og det retter sig ikke selv. Det ligner en bevidst spærring i
Energinets eget edge-lag.

`poll.js` kører derfor et sted, der ikke er en browser — i dette tilfælde på en
GitHub-runner. Den sender ingen `Origin`, får rigtige data, og lægger dem i en fil, som
browseren har lov til at læse.

---

## Tre måder at bruge kortet på

### 1. Åbn linket

https://seblynx.github.io/danmarks-elnet-live/

Ikke andet. Det virker på telefon, tablet og storskærm.

### 2. Hent `index.html` og åbn den fra din egen maskine

Klik på `index.html` her i repoet, vælg **Download raw file**, og dobbeltklik filen.

Den viser stadig live-tal. Kortet henter `data.json` fra dette repos adresse på GitHub
Pages, og den adresse sender `Access-Control-Allow-Origin: *`. Derfor må selv en fil, der
er åbnet fra skrivebordet, læse den.

Du kan sende filen videre som en almindelig vedhæftning. Modtageren får friske tal, så
længe workflowet her kører. Der kræves internetforbindelse.

### 3. Hoste det selv

Læg `index.html` på en webserver. Vil du have en kopi, der ikke afhænger af GitHub, så
læs videre.

---

## Hoster du det selv

Kortet leder efter data i denne rækkefølge:

| Kilde | Hvornår den bruges |
|---|---|
| `data.json` i samme mappe som siden | Hvis filen findes og målingen er under 3 timer gammel |
| `/api/` på samme host | Hvis der er en reverse proxy sat op |
| `data.json` på dette repos GitHub Pages | Hvis ingen af delene svarer |
| Indlejret 30-dages historik | Hvis alt andet fejler — mærket OFFLINE |

Uploader du kun `index.html`, virker kortet med det samme og henter data herfra. Vil du
være helt uafhængig af GitHub, skal du selv holde `data.json` frisk. Der er to veje.

### A. Reverse proxy — den bedste, hvis du har en rigtig webserver

Send `/api/` videre til API'et. Så opdaterer kortet sig selv hvert minut, der skrives
ingen filer, og der er ingen nøgle eller token at passe på.

```nginx
location /api/ {
    proxy_pass https://api.energidataservice.dk/;
    proxy_set_header Host api.energidataservice.dk;
    proxy_set_header Origin "";      # vigtigt: uden denne kommer der tomme svar
}
```

**IIS:** ARR/URL Rewrite til `https://api.energidataservice.dk/{R:1}`, og tøm `Origin` på
den udgående forespørgsel.
**Azure Front Door / CDN:** en route `/api/*` med `api.energidataservice.dk` som origin.

Test bagefter:

```
curl -s -o /dev/null -w '%{size_download}\n' "https://DIN-HOST/api/dataset/PowerSystemRightNow?limit=1"
```

Et tal over 0 betyder, at det virker. Får du 0, sendes `Origin` stadig med videre.

### B. Cron-job — hvis der ikke er en proxy

`poll.js` skriver `data.json`. Læg filen ved siden af `index.html`.

```
*/15 * * * * /usr/bin/node /sti/til/poll.js /sti/til/webroot/data.json >> /var/log/elnet-poll.log 2>&1
```

Krav: **Node.js 18 eller nyere** (scriptet bruger indbygget `fetch`). Ingen `npm install`,
ingen pakker. Filen er selvstændig. På Windows kan Opgavestyring køre samme kommando.

Scriptet returnerer exit-kode 1 ved fejl og skriver i så fald ikke filen, så en mislykket
kørsel efterlader den forrige `data.json` urørt.

**Cache:** server `data.json` med `Cache-Control: no-store`. Ellers kan et mellemliggende
CDN nå at gemme gårsdagens tal.

---

## Hvad der er målt, og hvad der er beregnet

Det er vigtigt for mig, at der ikke står tal på skærmen, som ser målte ud uden at være det.

**Målt** — direkte fra Energinet Energi Data Service, uden mellemregninger:
samlet produktion, havvind, landvind, sol, CO₂-udledning pr. kWh, udveksling på hver
udlandsforbindelse og day-ahead-priser pr. budområde.

**Kortlagt** — positioner fra OpenStreetMap: 6.271 vindmøller, 29 havmølleparker,
117 solcelleparker, elnettets tracé på 400 og 132/150 kV og de ni udlandsforbindelsers
kabelruter. Nettet er forenklet ±~500 m.

**Beregnet, og mærket med ≈ på skærmen:**

- MW pr. havmøllepark er en kapacitetsvægtet andel af den målte nationale havvind.
  Der findes ingen offentlige realtidsmålinger pr. park. Tallet er altså et estimat for
  den enkelte park, ikke en måling.
- Kapaciteten på 44 af de 117 solcelleparker er anslået ud fra det kortlagte areal,
  fordi den ikke er tagget i OpenStreetMap.
- Radius på 20 af de 29 havmølleparker er anslået ud fra kapaciteten.
- Tæthedsfelterne for landmøller er regnet ud fra de kortlagte mølleplaceringer.

**Tegnet, ikke data:** møllernes rotation og kablernes højde over havet. Selve
linjeføringen er den kortlagte rute.

Der er ingen animation af belastningen på de enkelte indenlandske ledninger. De data er
ikke offentlige, så laget er statisk topologi.

---

## Filer i repoet

| Fil | Hvad den er |
|---|---|
| `index.html` | Selve kortet. Én fil på ca. 1 MB med alt indeni — 3D-motor, geografi, infrastruktur og en indbygget 30-dages historik som reserve |
| `data.json` | Det nyeste måleøjeblik, ca. 470 bytes. Skrives af workflowet |
| `hist.json` | 30 dages historik i timeopløsning, ca. 70 KB. Tegner tidslinjen. Fornyes når den er over 6 timer gammel |
| `poll.js` | Henter det nyeste måleøjeblik. Node 18+, ingen pakker. Kan køres hvor som helst |
| `fetch.js` | Henter de 30 dages historik. Samme krav, ingen pakker |
| `compact.js` | Laver `fetch.js`-resultatet om til den lille `hist.json` |
| `.github/workflows/update-data.yml` | Tidsplanen. Kører scripterne og committer filerne |
| `README.md` | Denne fil |

Kortet virker **uden** `hist.json` — så bruger det den historik der er bygget ind i
`index.html`. Den er ældre, men korrekt, og det er den der gør at en enkelt downloadet
HTML-fil stadig virker uden net. Den nyeste af de to vinder altid, så en gammel udgivet
`hist.json` kan aldrig slå en nybygget indbygget.

Fordi workflowet committer `data.json`, får repoet en lille commit hver gang tallene
ændrer sig. Det er meningen, og det fylder næsten ingenting.

---

## Hvis der står OFFLINE

Kortet skriver selv i banneret, hvad der mangler. De tre tilfælde:

- **`data.json` findes ikke** — workflowet har aldrig kørt, eller filen ligger et andet sted end siden.
- **Data er for gamle** — sidste vellykkede kørsel er mere end 3 timer siden. Se Actions-fanen.
  En rød kørsel betyder som regel, at API'et var nede.
- **Filen kan ikke læses** — noget har overskrevet `data.json` med andet end det, `poll.js` skriver.

Du kan altid starte en kørsel manuelt: Actions-fanen → "Opdater data" → Run workflow.

GitHub slår i øvrigt planlagte kørsler fra efter 60 dage uden aktivitet i et repo.
Workflowets egne commits tæller som aktivitet, men kig forbi en gang imellem.

---

## Kilder

- **Måledata:** [Energinet Energi Data Service](https://www.energidataservice.dk) — åbne data.
  Datasæt `PowerSystemRightNow` og `DayAheadPrices`.
- **Positioner og netgeometri:** [OpenStreetMap](https://www.openstreetmap.org/copyright),
  licens ODbL. Krediteret i kortets footer.
- **Landegrænser:** Natural Earth (public domain).

Kortet er lavet som en demonstration, ikke som en driftet tjeneste fra Energinet. Brug
det som sådan.
