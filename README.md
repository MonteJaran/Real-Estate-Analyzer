# Real Estate Booster

> 🇷🇸 [Srpska verzija](README.sr.md)

Local web app for spotting land-value opportunities around **new and under-construction roads** across Europe (Montenegro, Serbia and North Macedonia fully researched, 37 more countries pre-configured). You track corridors early, capture land listings while browsing, contact owners, and match plots to premium buyers — or to your own billboard plays.

Everything runs on your machine, uses **free data sources** (OpenStreetMap Overpass, government sites), and stores data in a local SQLite file.

## Run

```
npm install     (once)
npm start       → http://localhost:3210
```

Requires Node 22+. No API keys needed. The database is created automatically at `server/data/booster.db`.

## Pages

| Page | What it does |
|---|---|
| **Dashboard** `/` | Counts, corridor watchlist (researched major projects per country), latest scraped announcements |
| **Map** `/map.html` | Leaflet map: roads under construction (orange) / proposed (red dashed) from OpenStreetMap, your captured lands (green, hover = full info popup), connection/access points (purple), POIs near roads, 5 km influence zone per road |
| **Land** `/lands.html` | Sortable/filterable database of every captured land: size, price, €/m², distance to nearest new road, estimated future price, contact tracking (status + call notes), buyer matching, CSV export, manual add |
| **Duplicates** `/duplicates.html` | Groups lands captured at the same coordinates (same plot on several portals) — price gaps between listings are negotiation intel. Adjustable match radius. Note: agencies sometimes pin different plots at one spot — check sizes. |
| **Buyers** `/buyers.html` | Researched buyer categories with site criteria (plot sizes, distances, requirements) + 25 companies actively expanding in ME/RS/MK with what they look for and contact hints |
| **Billboards** `/billboards.html` | Legal rules per country, rent/setup economics, and your captured lands **ranked by billboard suitability** with monthly revenue + payback calculations |
| **API status** `/apis.html` | Every data source: last run, calls today/month, ok-rate, job log, manual refresh buttons, optional Google API key |

## Data flow

- **Roads**: pulled from OpenStreetMap Overpass API (`highway=construction` / `highway=proposed`) per country. Geometry is stored with a point every 100 m plus detected **connection points** where the new road touches the existing network. Auto-refreshes **every 2 days at 06:00** while the app is running (plus a catch-up on startup); manual refresh anytime.
- **Announcements**: government road-agency/ministry/news pages (researched & verified per country in `server/data/countries.json`) are scraped for road-keyword links — this catches projects **before** they appear on any map.
- **Lands**: captured with the **Chrome extension** (`extension/` folder — see its README; Alt+S on any listing page) or added manually. On save the app computes distance to the nearest new road and an **estimated future price** (multiplier by road class and distance band, + bonus near access points).
- **POIs**: gas stations, hotels, restaurants, supermarkets, car dealers, industrial zones within 5 km of each new road — free from OpenStreetMap. Optional Google Places enrichment if you add an API key (kept under a monthly cap; app is fully functional without it).

## The 3% brokerage workflow

1. Watch the dashboard/map for corridors (e.g. Mateševo–Andrijevica, Morava Corridor, Kičevo–Ohrid opening end-2026).
2. Browse land portals for that area (verified per-country portal links are in `countries.json`; some portals block bots — that's fine, you browse and capture with Alt+S).
3. In the Land page: call owners, log notes, set `agreed_3pct`.
4. Press **Match buyers** on a land → categories whose size/distance criteria fit + companies active in that country, with contact hints.

## Billboards (your own revenue play)

Researched legal reality (Serbian *Zakon o putevima*; ME/MK analogous — **verify locally**): billboards are **banned on motorway mainlines** (60 m protective zone) but allowed ~7 m from state roads / ~5 m from municipal roads **with road-manager approval**. So the engine scores land near **interchange feeder roads** and non-motorway new roads. Calculation assumes a standard 12 m² double-faced board (~€4,000 setup), researched rent ranges (€50–350/face/month by location class, 70% occupancy) → payback typically 2–5 years including land. The page also shows the zero-effort alternative: leasing the spot to an ad company (€30–120/month).

## Scope & config

- Active countries: **40 across Europe** (ME/RS/MK fully researched; the rest use `major_roads_only` Overpass queries — motorway/trunk/primary construction only — with seed portals/sources that are not yet research-verified). Belarus is pre-configured but disabled; Russia and microstates are not included. Flip `enabled` in `server/data/countries.json` to change the set.
- With Europe-wide data, the map loads roads **by viewport** when no country is selected (zoom in or pick a country).
- Data files you can edit: `countries.json` (sources/portals/keywords), `buyers.json`, `billboards.json` (rates/rules), `projects.json` (watchlist).

## Honest limitations

- Some portals and tender sites block simple HTTP (Cloudflare etc.) — marked `needs_js`/`manual` on the API status page; use the extension on those.
- OSM `proposed` tagging is incomplete — the announcements scraper + corridor watchlist exist precisely to catch what OSM doesn't have yet.
- Future-price multipliers and billboard rents are **planning estimates**, not appraisals. Verify permits (road manager + municipality) before spending money.
- The scheduler runs only while the app is running.
