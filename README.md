# Danmarks Elnet — live

> **Privat hobbyprojekt.** Ikke et officielt Energinet-værktøj og ikke lavet af eller
> for Energinet. Tallene er Energinets **åbne data**, og de er krediteret som sådan —
> men kortet, designet og alle fejl i det er mine egne.

Et 3D-kort over det danske elsystem: produktion, CO₂, udveksling med nabolandene og
day-ahead-priser. Tallene opdaterer sig selv.

**Se kortet her: https://el.gridkort.dk/** (den gamle adresse seblynx.github.io/danmarks-elnet-live sender automatisk videre)

Kortet er én HTML-fil. Ingen backend, ingen API-nøgle, ingen installation. Ved siden af
filen ligger tre datafiler: `data.json` på ca. 470 bytes med det nyeste måleøjeblik,
`hist.json` på ca. 70 KB med de sidste 30 dages historik i timeopløsning — den der
tegner tidslinjen under kortet — og `prices.json` på ca. 1,5 KB med day-ahead-priserne
i kvarterer frem til i morgen aften (se [Kommende spotpriser](#kommende-spotpriser-og-hvornår-er-det-billigst)).

Dette repo indeholder det færdigbyggede kort. Selve kildekoden ligger i et privat repo.

**Live-tal (fra 30-09-2026):** kortet henter først fra `https://api.gridkort.dk/elnet/now.json`, en
Cloudflare Worker (`worker/worker.js`), der spørger Energinet uden om browserens spærring og holder
svaret i 60 sekunder. Tallene er derfor typisk 1-2 minutter gamle. Energinet ser højst ét kald i
minuttet fra hvert Cloudflare-sted, uanset hvor mange der har kortet åbent, og priserne hentes kun
hvert 15. minut. Svarer workeren ikke, falder kortet selv tilbage på `data.json` nedenfor.

---

## Tallene opdaterer sig selv

`.github/workflows/update-data.yml` er sat til at køre hvert 15. minut. Hver kørsel gør
fire ting:

1. Henter `PowerSystemRightNow` og `DayAheadPrices` fra Energinet Energi Data Service.
2. Tjekker at alle felter er tal, og at tidsstemplet ser rigtigt ud.
3. Skriver resultatet til `data.json` — og de kommende kvarterspriser til `prices.json`.
4. Committer filerne tilbage til repoet, men kun hvis tallene har ændret sig.

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

## Kommende spotpriser og »Hvornår er det billigst?«

Under tidslinjen ligger striben **Kommende elpriser** med day-ahead-priserne for DK1 og
DK2 i kvarterer, fra to timer før den igangværende time og frem til det sidste kvarter
Energinet har offentliggjort — normalt i morgen kl. 23:45, når dagens auktion er afgjort
mellem kl. 13 og 14. Knappen **Hvornår er det billigst?** markerer de billigste
sammenhængende **1, 3 og 8 timer** blandt de resterende fremtidige kvarterer i hvert
prisområde, til elbilen, opvaskemaskinen eller varmepumpen, og skriver tidsrum og
gennemsnitspris under striben. Et vindue begynder tidligst ved det næste hele kvarter.
Tallet er **spotpris, før nettarif, afgifter og moms** — ingen tariffer, ingen samlet
pris. Det er feltet `DayAheadPriceDKK` (DKK/MWh) delt med 1000. På engelsk (`?lang=en`)
hedder knappen *When is it cheapest?*.

I kiosk-tilstand (`?kiosk` eller tasten K) er tidslinjekortet skjult; der viser kiosken i
stedet den samme stribe med vinduerne markeret som et af sine faste indslag: et kort med
den billigste 3-timers pris i Vestdanmark som overskrift, mærket med område og vindue,
striben under og kildeangivelsen nederst.

Vinduerne er mærket »1 t«, »3 t« og »8 t« i en bane over søjlerne, skraveret som deres
bånd og skubbet til højre, hvis to ellers ville røre hinanden — to mærkater deler aldrig
plads. Teksten i striben er 11 px og bliver aldrig mindre; banen og tidsaksen er målt ud
fra skriften, og søjlerne får resten. På en computer tager teksten med tidsrummene titlens
plads i striben, mens knappen er slået til, så kortet under tidslinjen ikke vokser og ikke
skubber til de andre kort.

**Lave skærme** (en bærbar på 1280×800 eller 1366×768) kan ikke rumme alle kort helt over
tidslinjen. Intet kort klippes midt i en række. I venstre spalte giver noget efter i denne
rækkefølge, indtil produktionskortet står helt: signaturforklaringen mister linjen med
tastaturgenveje, dens farverækker stilles to og to, produktionskortets fordeling bliver en
kompakt liste uden den beregnede forbrugslinje, og til sidst står kun overskriften (samlet
produktion og andelen af vind og sol). I højre spalte stilles de fire felter først to og to;
rækker forbindelseskortet stadig ikke, beholder det hele rækker og ruller indeni, og kan
færre end tre rækker stå, udelades det. Det måles ved hver størrelsesændring, så et højere
vindue får det hele tilbage.

**Data:** Browseren kalder aldrig Energinet for priserne. Kortet læser dem samme vej som
de aktuelle tal: først workeren på `api.gridkort.dk/elnet/prices.json`
(`worker/worker.js`, der spørger Energinet og holder svaret i 15 min — så er morgendagens
priser med et kvarter efter offentliggørelsen), så `prices.json` ved siden af siden, så
filen i dette repo. `prices.js` henter samme datasæt `DayAheadPrices` (15 minutters
opløsning; det erstattede `Elspotprices`, som stoppede september 2025 og ikke bruges) i
workflowet og skriver `prices.json` som reserven. Workflowet kører scriptet i hver kørsel
som en bonus ligesom historikken: fejler kaldet, udgives `data.json` stadig. Lander
kørslen efter kl. 13 dansk tid, og er morgendagens priser ikke ude endnu, venter scriptet
og prøver igen op til fire gange med to minutters mellemrum; et HTTP 429 besvares med
pause (`Retry-After`, ellers 30 s fordoblet) før næste forsøg. Mangler filen, kan den
ikke læses, eller slutter den i fortiden, står der én linje om det i striben, knappen er
slået fra, og resten af kortet virker som før. Tidsaksen er UTC i filen og omregnes til
dansk tid pr. kvarter, så skiftet til vintertid (25-10-2026 har 25 timer) ikke
forskyder noget.

**Priskortene DK1 Vest og DK2 Øst** viser samme tal: det igangværende kvarter fra
samme kilde som striben (workeren, ellers `prices.json`), `DayAheadPriceDKK` delt med
1000, med kvarteret skrevet under tallet. Så
står der det samme kr./kWh i kortet og i striben for samme kvarter. Mangler
`prices.json` — eller under afspilning af historikken, som kun findes i €/MWh — falder
kortene tilbage på €/MWh omregnet med fastkurs 7,46, og linjen under tallet siger
»omregnet 7,46«. Mærkatet er det samme overalt: *spotpris, før nettarif, afgifter og moms*.

**Fallback-tilstanden kan fremkaldes** med `?udenpriser` i adressen
(`https://el.gridkort.dk/?udenpriser`): kortet lader som om hverken workeren eller
`prices.json` svarer, så
striben viser sin ene linje, knappen er slået fra, og priskortene bruger omregningen.
Samme tilstand opstår af sig selv, hvis filen mangler, ikke kan læses eller slutter i
fortiden.

**Licens:** data fra Energinet under CC BY 4.0. Striben, kiosk-indslaget og info-panelet
skriver »Kilde: Energinet (www.energidataservice.dk)« og at tallene er bearbejdet
(omregnet fra DKK/MWh til kr./kWh og vist pr. kvarter). Energinet står ikke bag kortet, se
uafhængighedslinjen i signaturforklaringen.

**Test:** `node --test` kører testene i `test/` — udregningen af de billigste vinduer,
tegningen af striben (begge sprog, æøå, fallback uden data), `prices.js` med 429-pause
og »er i morgen ude?«-tjekket. Node 18+, ingen pakker. Testen kører den kodeblok der
faktisk ligger i `index.html`.

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

https://el.gridkort.dk/

Ikke andet. Det virker på telefon, tablet og storskærm. Er „reducer bevægelse“ slået til i styresystemet, klipper
kameraet i stedet for at flyve, og rotorer, kabelpulser og hav står stille.

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
| `api.gridkort.dk` (Cloudflare Worker) | Først, altid. Svarer den med en måling under 8 min, bruges den |
| `data.json` i samme mappe som siden | Hvis filen findes og målingen er under 3 timer gammel |
| `data.json` på dette repos GitHub Pages | Hvis ingen af delene svarer |
| Indlejret 30-dages historik | Hvis alt andet fejler — mærket OFFLINE |

Uploader du kun `index.html`, virker kortet med det samme og henter data herfra. Vil du
være helt uafhængig af GitHub, skal du selv holde `data.json` og `prices.json` friske.

Browseren kalder aldrig `api.energidataservice.dk` — hverken direkte eller gennem en
reverse proxy. Energinet beder om, at sitet selv henter data og serverer dem, så den
tidligere `/api/`-mulighed er taget ud: alle tal kommer fra filer, et script har skrevet.

### Cron-job

`poll.js` skriver `data.json`, `prices.js` skriver `prices.json`. Læg filerne ved siden
af `index.html`.

```
*/15 * * * * /usr/bin/node /sti/til/poll.js   /sti/til/webroot/data.json   >> /var/log/elnet-poll.log 2>&1
*/15 * * * * /usr/bin/node /sti/til/prices.js /sti/til/webroot/prices.json >> /var/log/elnet-poll.log 2>&1
```

Krav: **Node.js 18 eller nyere** (scriptet bruger indbygget `fetch`). Ingen `npm install`,
ingen pakker. Filen er selvstændig. På Windows kan Opgavestyring køre samme kommando.

Scripterne returnerer exit-kode 1 ved fejl og skriver i så fald ikke filen, så en mislykket
kørsel efterlader den forrige fil urørt.

**Cache:** server `data.json` og `prices.json` med `Cache-Control: no-store`. Ellers kan et
mellemliggende CDN nå at gemme gårsdagens tal.

---

## Hvad der er målt, og hvad der er beregnet

Det er vigtigt for mig, at der ikke står tal på skærmen, som ser målte ud uden at være det.

**Målt** — direkte fra Energinet Energi Data Service, uden mellemregninger:
samlet produktion, havvind, landvind, sol, CO₂-udledning pr. kWh, udveksling på hver
udlandsforbindelse og day-ahead-priser pr. budområde.

**Kortlagt** — positioner fra OpenStreetMap: 6.267 vindmøller, 29 havmølleparker,
121 solcelleparker, elnettets tracé på 400 og 132/150 kV og de ni forbindelsers
kabelruter (otte til udlandet og Storebælt). Nettet er forenklet ±~500 m.

**Beregnet, og mærket med ≈ på skærmen:**

- MW pr. havmøllepark er en kapacitetsvægtet andel af den målte nationale havvind.
  Der findes ingen offentlige realtidsmålinger pr. park. Tallet er altså et estimat for
  den enkelte park, ikke en måling.
- Kapaciteten på 52 af de 121 solcelleparker er anslået ud fra det kortlagte areal,
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
| `prices.js` | Henter day-ahead-priserne for DK1 og DK2 i kvarterer og skriver `prices.json` |
| `prices.json` | Kommende spotpriser i DKK/MWh, ca. 1,5 KB. Skrives af workflowet. Tegner pris-striben under tidslinjen |
| `test/` | `node --test`: billigste vinduer, tegning af striben, `prices.js` |
| `.github/workflows/update-data.yml` | Tidsplanen. Kører scripterne og committer filerne |
| `README.md` | Denne fil |
| `robots.txt`, `sitemap.xml`, `llms.txt` | Til søgemaskiner og AI-søgemaskiner. `llms.txt` beskriver kortet, kilderne og hvad der er beregnet. Ret den, hvis kortet ændrer sig |
| `404.html` | Siden for en forkert adresse på el.gridkort.dk |
| `tv2/index.html` | Sender `el.gridkort.dk/tv2` videre til TV 2-indslaget. Se [TV 2-indslag i kiosk-tilstand](#tv-2-indslag-i-kiosk-tilstand) |

Kortet virker **uden** `hist.json` — så bruger det den historik der er bygget ind i
`index.html`. Den er ældre, men korrekt, og det er den der gør at en enkelt downloadet
HTML-fil stadig virker uden net. Den nyeste af de to vinder altid, så en gammel udgivet
`hist.json` kan aldrig slå en nybygget indbygget.

Fordi workflowet committer `data.json`, får repoet en lille commit hver gang tallene
ændrer sig. Det er meningen, og det fylder næsten ingenting.

---

## TV 2-indslag i kiosk-tilstand

Kiosk-tilstanden kan vise en QR-kode til et TV 2-indslag. Koden kommer cirka hvert
75. sekund og står i 15 sekunder. Uden for kiosk står indslaget som et link i kortet
med signaturforklaringen. Funktionen er slået fra, så længe der ikke står en titel.

Sådan slår du den til:

1. Skriv indslagets adresse i `tv2/index.html`: `const CLIP = 'https://nyheder.tv2.dk/...';`
2. Skriv titlen i `index.html`: `const CLIP = { title: 'Titlen på indslaget', ... };`

QR-koden peger altid på `https://el.gridkort.dk/tv2`, og den side sender videre til
indslaget. Skifter du indslaget, retter du kun de to linjer. QR-koden er den samme.
Vil du slå funktionen fra igen, så tøm begge linjer. Så sender `/tv2` folk til kortet.

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
  Datasæt `PowerSystemRightNow` og `DayAheadPrices`. Kilde: Energinet
  (www.energidataservice.dk), licens CC BY 4.0. Tallene er bearbejdet (omregnet og
  samlet); kildeangivelsen står også i kortets info-panel og ved pris-striben.
- **Positioner og netgeometri:** [OpenStreetMap](https://www.openstreetmap.org/copyright),
  licens ODbL. Krediteret i kortets footer.
- **Landegrænser:** Natural Earth (public domain).

Kortet er lavet som en demonstration, ikke som en driftet tjeneste fra Energinet. Brug
det som sådan.
