# Real Estate Booster

> 🇬🇧 [English version](README.md)

Lokalna web aplikacija za pronalaženje prilika za rast vrednosti zemljišta oko **novih i puteva u izgradnji** — Crna Gora, Srbija i Severna Makedonija su potpuno istražene, još 37 evropskih država je unapred konfigurisano. Pratiš koridore rano, hvataš oglase za zemljište dok pregledaš internet, kontaktiraš vlasnike i uparuješ parcele sa premium kupcima — ili sa sopstvenim bilbord planom.

Sve radi na tvom računaru, koristi **besplatne izvore podataka** (OpenStreetMap Overpass, državni sajtovi) i čuva podatke u lokalnom SQLite fajlu.

## Pokretanje

```
npm install     (jednom)
npm start       → http://localhost:3210
```

Potreban Node 22+. Bez API ključeva. Baza se pravi automatski na `server/data/booster.db`.

## Stranice

| Stranica | Šta radi |
|---|---|
| **Dashboard** `/` | Brojači, watchlist koridora (istraženi veliki projekti po državi), najnovije skenirane objave |
| **Mapa** `/map.html` | Leaflet mapa: putevi u izgradnji (narandžasto) / planirani (crveno isprekidano) sa OpenStreetMap-a, tvoje sačuvane parcele (zeleno, hover = pun opis), priključne tačke (ljubičasto), POI objekti pored puteva, zona uticaja od 5 km po putu |
| **Zemljište** `/lands.html` | Sortabilna baza svih sačuvanih parcela: kvadratura, cena, €/m², udaljenost do najbližeg novog puta, procenjena buduća cena, praćenje kontakata (status + beleške sa poziva), uparivanje kupaca, CSV izvoz, ručni unos |
| **Duplikati** `/duplicates.html` | Grupiše parcele sačuvane na istim koordinatama (ista parcela na više portala) — razlika u ceni između oglasa je materijal za pregovaranje. Podesiv radijus poklapanja. Napomena: agencije ponekad pinuju različite parcele na istu tačku — proveri kvadraturu. |
| **Kupci** `/buyers.html` | Istražene kategorije kupaca sa kriterijumima lokacije (kvadratura, udaljenost, zahtevi) + 25 firmi koje se aktivno šire u ME/RS/MK, sa tim šta traže i kako do kontakta |
| **Bilbordi** `/billboards.html` | Pravna pravila po državi, ekonomika zakupa i postavljanja, i tvoje parcele **rangirane po podobnosti za bilbord** sa izračunom mesečnog prihoda i povraćaja ulaganja |
| **Status API-ja** `/apis.html` | Svaki izvor podataka: poslednje pokretanje, pozivi danas/mesečno, procenat uspešnosti, log poslova, dugmad za ručno osvežavanje, opcioni Google API ključ |

## Tok podataka

- **Putevi**: povlače se sa OpenStreetMap Overpass API-ja (`highway=construction` / `highway=proposed`) po državi. Geometrija se čuva sa tačkom na svakih 100 m plus detektovane **priključne tačke** gde novi put dodiruje postojeću mrežu. Automatsko osvežavanje **na svaka 2 dana u 06:00** dok aplikacija radi (plus nadoknada pri pokretanju); ručno osvežavanje bilo kada.
- **Objave**: stranice državnih putarskih agencija, ministarstava i vesti (istražene i verifikovane po državi u `server/data/countries.json`) se skeniraju za linkove sa ključnim rečima o putevima — ovo hvata projekte **pre** nego što se pojave na bilo kojoj mapi.
- **Zemljište**: hvata se **Chrome ekstenzijom** (folder `extension/` — vidi njen README; Alt+S na bilo kojoj stranici oglasa) ili se unosi ručno. Pri snimanju aplikacija računa udaljenost do najbližeg novog puta i **procenjenu buduću cenu** (množilac po klasi puta i pojasu udaljenosti, + bonus blizu priključaka).
- **POI objekti**: pumpe, hoteli, restorani, marketi, auto-placevi, industrijske zone u krugu od 5 km od svakog novog puta — besplatno sa OpenStreetMap-a. Opciono obogaćivanje preko Google Places ako dodaš API ključ (drži se ispod mesečnog limita; aplikacija radi u potpunosti i bez njega).

## Radni tok posrednika (3%)

1. Prati dashboard/mapu za koridore (npr. Mateševo–Andrijevica, Moravski koridor, Kičevo–Ohrid).
2. Pregledaj portale sa zemljištem za tu oblast (verifikovani linkovi po državi su u `countries.json`; neki portali blokiraju botove — nema veze, ti pregledaš i hvataš sa Alt+S).
3. Na stranici Zemljište: zovi vlasnike, upisuj beleške, podesi `agreed_3pct`.
4. Pritisni **Match buyers** na parceli → kategorije čiji kriterijumi kvadrature/udaljenosti odgovaraju + firme aktivne u toj državi, sa savetom za kontakt.

## Bilbordi

Istražena pravna realnost (srpski *Zakon o putevima*; ME/MK analogno — **proveri lokalno**): bilbordi su **zabranjeni uz trasu autoputa** (zaštitni pojas 60 m), ali dozvoljeni na ~7 m od državnih i ~5 m od opštinskih puteva **uz saglasnost upravljača puta**. Zato modul rangira zemljište pored **prilaznih puteva petlji** i novih puteva koji nisu autoputevi. Izračun pretpostavlja standardni dvostrani bilbord od 12 m² (~4.000 € postavljanje), istražene raspone zakupa (50–350 €/strana/mesečno po klasi lokacije, 70% popunjenost) → povraćaj obično 2–5 godina uključujući zemljište. Stranica prikazuje i varijantu bez truda: izdavanje lokacije reklamnoj agenciji (30–120 €/mesečno).

## Obuhvat i konfiguracija

- Aktivne države: **40 širom Evrope** (ME/RS/MK potpuno istražene; ostale koriste `major_roads_only` Overpass upite — samo izgradnja autoputeva/brzih/magistralnih puteva — sa početnim portalima i izvorima koji još nisu verifikovani istraživanjem). Belorusija je konfigurisana ali isključena; Rusija i mikro-države nisu uključene. Promeni `enabled` u `server/data/countries.json` da izmeniš skup.
- Sa podacima za celu Evropu, mapa učitava puteve **po vidnom polju** kada država nije izabrana (zumiraj ili izaberi državu).
- Fajlovi sa podacima koje možeš menjati: `countries.json` (izvori/portali/ključne reči), `buyers.json`, `billboards.json` (cene/pravila), `projects.json` (watchlist).

## Poštena ograničenja

- Neki portali i tenderski sajtovi blokiraju običan HTTP (Cloudflare i sl.) — označeni su kao `needs_js`/`manual` na stranici statusa API-ja; na njima koristi ekstenziju.
- OSM `proposed` oznake su nepotpune — scraper objava i watchlist koridora postoje upravo da uhvate ono što OSM još nema.
- Množioci buduće cene i cene zakupa bilborda su **procene za planiranje**, ne procena veštaka. Proveri dozvole (upravljač puta + opština) pre nego što uložiš novac.
- Scheduler radi samo dok aplikacija radi.
