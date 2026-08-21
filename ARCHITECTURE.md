# Real Estate Booster — Architecture Contract

Local web app that tracks new/under-construction roads (via OpenStreetMap Overpass + government announcement pages) and land for sale within 5 km (captured via a Chrome extension), across 9 countries: ME RS MK BA HR SI SK AL GR.

**This file is the binding contract.** Every module must implement exactly these interfaces. If you must deviate, note it in your final summary.

## Stack rules (non-negotiable)

- Node 22, **CommonJS** (`require`/`module.exports`), NO TypeScript, NO build step.
- Only deps: `express`, `cheerio`, `node-cron`. SQLite via built-in `node:sqlite` — always through `server/db.js`, never open the DB directly.
- Server listens on **http://localhost:3210**. Frontend is plain HTML/CSS/JS served statically from `public/` (no framework). Leaflet loaded from CDN (unpkg) in HTML pages.
- Global `fetch` is available (Node 22) — use it, no axios/node-fetch.
- All timestamps ISO-8601 strings via `db.nowIso()`.
- Coordinates are `[lat, lon]` everywhere (Leaflet order), NOT GeoJSON `[lon, lat]` — EXCEPT inside GeoJSON responses of `GET /api/roads`, which must be valid GeoJSON (lon,lat).

## File ownership (each build agent writes ONLY its own files)

- **Agent A (server core)**: `server/index.js`, `server/routes/{roads,lands,pois,buyers,status,announcements,settings}.js`
- **Agent B (services)**: `server/services/{geo,overpass,roadsources,scheduler,pricing,google}.js`
- **Agent C (frontend shell + map)**: `public/index.html`, `public/css/style.css`, `public/js/{nav,api}.js`, `public/map.html`, `public/js/map.js`
- **Agent D (frontend data pages)**: `public/lands.html`, `public/js/lands.js`, `public/apis.html`, `public/js/apis.js`, `public/buyers.html`, `public/js/buyers.js`
- **Agent E (extension)**: everything under `extension/`

Already written (read, do not modify): `server/db.js`, `server/data/countries.json`, `server/data/buyers.json`, `package.json`.

## Database

See `server/db.js` for the full schema (tables: roads, road_points, road_connections, lands, pois, announcements, api_log, settings). Exports: `getDb()`, `nowIso()`, `logApi(apiName, endpoint, ok, ms, items, note)`, `getSetting(key, fallback)`, `setSetting(key, value)`.

## Data files

`server/data/countries.json`: `{ "countries": [{ iso2, name, enabled, overpass_area (ISO2 string), keywords: [..announcement keywords..], road_sources: [{name,url,kind,scrape_method,language,verified}], portals: [{name,url,land_search_url}] }] }`

`server/data/buyers.json`: `{ "categories": [{category, min_size_m2, max_size_m2, max_distance_from_road_m, requirements, why_premium}], "companies": [{name, sector, countries:[iso2], looking_for, expansion_signals, contact_hint}] }`

Both are read fresh from disk on each request (they get updated while the server runs).

## REST API (Agent A implements; B provides services; C/D consume)

Error convention: on failure respond `500 {"error": "message"}` (or 400/404 where noted). All bodies JSON. `express.json({limit:'2mb'})`.

CORS (for the Chrome extension): on `/api/*` set `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`; answer `OPTIONS` with 204.

### Roads
- `GET /api/roads?country=RS&status=construction` — both params optional. Returns GeoJSON FeatureCollection; each Feature: LineString geometry (lon,lat) + properties `{id, osm_id, name, ref, road_type, status, length_m, country, source, last_seen, connections_count}`.
- `GET /api/roads/:id` — `{road: {...row, geometry: [[lat,lon],...], tags: {...}}, points: [{seq,lat,lon}], connections: [{id,lat,lon,kind,note}]}`. 404 if missing.
- `POST /api/roads/refresh` body `{country?: "RS"}` — starts background refresh via `scheduler.refreshRoads(country|null)`. Returns `202 {started: true, running: {...}}`. If already running returns `409 {error, running}`.
- `GET /api/refresh/status` — `scheduler.getStatus()` (see below).

### Lands
- `GET /api/lands` — query params, all optional: `country, contacted (0|1), contact_status, min_size, max_size, min_price, max_price, max_distance, q` (q = LIKE over title/location_text/description), `sort` (any lands column, default `captured_at`), `dir` (asc|desc, default desc), `limit` (default 500), `offset`. Returns `{items: [...], total: N}` (total = count with same filters, ignoring limit/offset).
- `GET /api/lands/:id` — full row (parse `images`/`raw` JSON into objects). 404 if missing.
- `POST /api/lands/capture` — body `{url, source_site?, title?, price_eur?, size_m2?, lat?, lon?, country?, location_text?, contents?, description?, images?: [..], owner_contact?, raw?: {}}`. Upsert by `url` (update non-null incoming fields if exists). After save: if lat/lon present, compute `nearest_road_id` + `distance_to_road_m` via `geo.nearestRoad(lat,lon)` and `future_price_eur`/`future_price_note` via `pricing.estimate(land, road)`; derive `price_per_m2` when both price and size present; infer `country` from coordinates bbox of countries if absent (via `geo.countryOf(lat,lon)` — nullable ok). Returns the saved row (200).
- `POST /api/lands` — same body/behavior as capture (manual entry uses it; if no `url`, generate `manual:<timestamp>` as url).
- `PATCH /api/lands/:id` — partial update of any writable column (`contacted, contact_status, call_notes, owner_contact, title, price_eur, size_m2, lat, lon, country, location_text, contents, description`). If lat/lon/price/size changed, recompute derived fields as in capture. Returns updated row.
- `DELETE /api/lands/:id` — `{deleted: true}`.
- `POST /api/lands/recompute` — recompute nearest road/distance/future price for ALL lands with lat/lon (call after road refresh). Returns `{updated: N}`.

### POIs
- `GET /api/pois?country=&kind=&road_id=` — array of rows.
- `POST /api/pois/refresh` body `{country}` — via `scheduler.refreshPois(country)`, background, 202 like roads/refresh.

### Buyers
- `GET /api/buyers` — contents of buyers.json.
- `GET /api/buyers/match/:landId` — `{land: {...}, categories: [matching categories], companies: [companies whose sector matches a matching category AND operate in land.country]}`. Category matches when land.size_m2 between min/max (when both known) AND land.distance_to_road_m <= max_distance_from_road_m (when known). Sector↔category mapping: fuel-ev→[fuel/gas station, EV charging hub, truck stop / rest area], retail-food→[drive-thru fast food, supermarket/discounter, retail park], hotel-rest→[roadside motel/hotel], auto-logistics→[car dealership, logistics warehouse]. Match loosely by lowercase substring so research-supplied names still map.

### Status
- `GET /api/status` — `{apis: [{api_name, last_call_ts, last_ok, calls_today, calls_month, items_month, ok_rate_month, limit_note}], scheduler: scheduler.getStatus(), sources: [flattened road_sources from countries.json with per-source api_log stats using api_name 'source:<iso2>:<name>']}`. Limits: overpass `"~10k/day fair use, throttled 3s between calls"`, google_places `"free tier: 5000 calls/mo hard stop (configurable)"`.
- `GET /api/status/log?api_name=&limit=100` — recent api_log rows, newest first.

### Announcements
- `GET /api/announcements?country=` — rows newest first.
- `POST /api/announcements/refresh` body `{country?}` — via `scheduler.refreshAnnouncements(country|null)`, background, 202.

### Settings
- `GET /api/settings` — all settings as `{key: value}` (mask `google_api_key` to last 4 chars).
- `PUT /api/settings` — body `{key: value, ...}` stored via setSetting. Returns updated masked map.

### Static
- `express.static('public')`; `/` serves `public/index.html`.

## Services (Agent B implements)

### `geo.js`
- `haversineM(lat1, lon1, lat2, lon2)` → meters.
- `lineLengthM(coords)` — coords `[[lat,lon],...]`.
- `interpolateEveryM(coords, stepM)` → `[{lat,lon}]` including first and last vertex, points every `stepM` along the line.
- `pointToLineDistanceM(lat, lon, coords)` → min distance in meters from point to polyline (segment projection, equirectangular approx is fine).
- `nearestRoad(lat, lon, maxM = 30000)` → `{road_id, distance_m, road}` or `null`. Prefilter roads by bbox expanded by maxM using roads.min/max lat/lon columns, then exact distance on parsed geometry.
- `countryOf(lat, lon)` → iso2 or null. Hardcode a coarse bbox per the 9 countries; when bboxes overlap prefer the smaller country. Good enough for tagging.
- `bboxOf(coords, padM)` → `{minLat, minLon, maxLat, maxLon}`.

### `overpass.js`
Overpass endpoints (rotate on failure): `https://overpass-api.de/api/interpreter`, `https://overpass.kumi.systems/api/interpreter`. Serialize ALL overpass calls through one internal queue with ≥3000 ms between requests; timeout 90 s; `db.logApi('overpass', <query summary>, ok, ms, items, note)` for every call.
- `fetchRoads(iso2)` → for area `["ISO3166-1"="<iso2>"][admin_level=2]`, fetch ways `highway=construction` and `highway=proposed` with `out geom;`. Map to `[{osm_id:'way/<id>', name, ref, road_type (from construction=*/proposed=* tag, else 'unknown'), status, coords: [[lat,lon],...], tags}]`. Skip ways with <2 points.
- `fetchConnections(iso2)` → nodes shared between those ways and the existing network: `way[highway=construction](area.a)->.c; node(w.c)->.cn; way(bn.cn)[highway][highway!~"construction|proposed"]->.x; node(w.c)(w.x); out;` (and same for proposed) → `[{lat, lon, note: 'touches existing road'}]`.
- `fetchPoisNear(coordsList, radiusM = 5000)` — `coordsList` = array of road geometries; build `around` queries per road (chunk long roads); fetch nodes/ways with tags: `amenity~"fuel|charging_station|restaurant|fast_food"`, `tourism~"hotel|motel"`, `shop~"supermarket|mall|car"`, `landuse=industrial`. Return `[{osm_id, name, kind, lat, lon, tags}]` (ways → centroid). Map kind: fuel, charging, restaurant, fast_food, hotel, supermarket, shop, car_dealer, industrial.

### `roadsources.js`
- `refreshAnnouncements(countryCfg)` — for each `road_sources` entry with `scrape_method` of `static_html`/`rss`: fetch (User-Agent `RealEstateBooster/1.0 (personal research tool)`, timeout 30 s), parse with cheerio, collect `<a>` whose text (lowercased, diacritics-insensitive where easy) contains any of `countryCfg.keywords`; resolve relative hrefs; INSERT OR IGNORE into announcements; `logApi('source:<iso2>:<name>', url, ok, ms, newCount, note)`. Skip `needs_js` sources (log note 'needs_js — skipped'). Politeness delay ≥2 s between sources. Returns `{country, newCount}`.

### `scheduler.js`
In-memory job state (module-level): `{running: null | {type, country, startedAt, log: [..last 50 lines..]}, lastRun: {roads: ts, pois: ts, announcements: ts}}` — persist lastRun in settings (`last_refresh_roads`, etc).
- `getStatus()` → that state + `nextCronRun` (compute from cron pattern) + per-country road counts.
- `refreshRoads(iso2OrNull)` — async job (fire and forget; guard: one job at a time). For each enabled country (or just the one): `overpass.fetchRoads` → upsert into roads by `osm_id` (update `last_seen`, geometry, bbox via `geo.bboxOf`, `length_m` via `geo.lineLengthM`; set `first_seen` on insert); rebuild `road_points` (`geo.interpolateEveryM(coords, 100)`); rebuild `road_connections` from `overpass.fetchConnections` (kind `junction_existing`, match each node to the nearest stored road ≤100 m) + both endpoints of each road (kind `endpoint`). Delete roads for that country whose `last_seen` older than 30 days (disappeared from OSM). Then recompute all lands' nearest road (same logic as `POST /api/lands/recompute`). Update `last_refresh_roads`.
- `refreshPois(iso2)` — `overpass.fetchPoisNear` over that country's stored road geometries; upsert pois by osm_id with nearest stored road + distance.
- `refreshAnnouncements(iso2OrNull)` — loop countries → `roadsources.refreshAnnouncements`.
- `init()` — called from index.js: `cron.schedule('0 6 */2 * *', ...)` → refreshRoads(null) then refreshAnnouncements(null); on startup, if `last_refresh_roads` missing or older than 2 days, kick refreshRoads(null) after 15 s delay.

### `pricing.js`
- `estimate(land, road)` → `{future_price_eur, note}` or `{future_price_eur: null, note: 'no price or no road nearby'}`. Multiplier by road_type group and distance: motorway/trunk: <500 m ×3.0, <1000 ×2.2, <2000 ×1.7, <3500 ×1.35, ≤5000 ×1.15; other types: ×2.2/×1.8/×1.4/×1.2/×1.1. If a `road_connections` point is within 1000 m of the land, add +0.5. Cap ×5. `future_price_eur = price_eur × multiplier`, note explains (e.g. "×2.2 — 800 m from A1 motorway (construction), near access point"). Round to whole EUR.

### `google.js` (optional enrichment, off unless key set)
- `isEnabled()` → !!getSetting('google_api_key').
- `enrichPois(iso2)` — Places API (New) Nearby Search around stored road midpoints (radius 5000, types: gas_station, lodging, restaurant, supermarket, car_dealer); before each call check month usage from api_log (`google_places`) vs `getSetting('google_monthly_cap', 5000)` — refuse when reached. Upsert into pois with `source='google'`, osm_id `google/<place_id>`. Log every call.

## Frontend (Agents C & D)

Shared shell: every page includes `css/style.css`, `js/api.js`, `js/nav.js`. Dark-friendly clean design, sans-serif, top navbar with links: Dashboard `/`, Map `/map.html`, Land `/lands.html`, Buyers `/buyers.html`, API status `/apis.html` + right-aligned "Refresh roads" button (POST /api/roads/refresh, then poll /api/refresh/status, show spinner state in navbar).
- `js/nav.js`: `renderNav(activeId)` injects the navbar into `#nav`; each page calls it with its id (`dash|map|lands|buyers|apis`).
- `js/api.js`: `window.API = {get(path), post(path, body), patch(path, body), del(path)}` — fetch wrappers, JSON, throw `Error(msg)` on !ok.

Pages:
- `index.html` (C): dashboard — cards with counts (roads by status, lands total/contacted, POIs, announcements — from the list endpoints), country filter chips, recent announcements list (linking out), quick links to the other pages.
- `map.html` + `js/map.js` (C): full-height Leaflet map (OSM tiles, attribution). Layers with a control: Roads under construction (orange, weight 4), Proposed roads (red dashed), Connection points (purple circle markers, popup with kind/note), Land (green markers; **popup on mouseover** with title, size m², price €, €/m², distance to road, est. future price, contacted badge; click → `lands.html#land-<id>`), POIs (small icons by kind, toggleable, loaded per current country selection). Country dropdown (from countries.json via a tiny `GET /api/status` sources list or hardcode the 9) → fits map to that country's roads. Roads fetched from `/api/roads` GeoJSON (`L.geoJSON` with style by `properties.status`). Clicking a road: popup with name/ref/type/status/length + buttons "Load POIs near this road" (GET /api/pois?road_id=) and "Show 5 km zone" (L.polyline buffer approximation: draw translucent circles r=5000 along road_points every ~1 km, or L.polygon if simpler).
- `lands.html` + `js/lands.js` (D): filter bar (country select, contacted select, min/max size, min/max price, max distance, text search) + sortable table (click header toggles sort, server-side via query params): title(link to url), country, size_m2, price_eur, price_per_m2, distance_to_road_m, future_price_eur, contents, contacted, contact_status, captured_at. Row click expands detail panel: description, images (thumbnails), owner_contact, call notes textarea + contact_status select + contacted checkbox with Save (PATCH), Delete button, "Match buyers" button → calls /api/buyers/match/:id and renders matching categories/companies inline. "Add land manually" button opens a form (POST /api/lands). "Export CSV" downloads current filtered set client-side.
- `buyers.html` + `js/buyers.js` (D): two sections — Categories table (all criteria columns) and Companies (cards or table; filter by country chip + sector select; show looking_for, expansion_signals, contact_hint).
- `apis.html` + `js/apis.js` (D): cards per api from /api/status (last call, ok, calls today/month, limit note), scheduler panel (running job + log lines, last runs, next cron run), sources table (per government source: last scrape, new items), buttons: "Refresh roads now", "Refresh announcements", "Refresh POIs (country select)", recent log table (/api/status/log). Settings box: Google API key input + monthly cap (PUT /api/settings).

Leaflet via CDN: `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` and `.../leaflet.js`.

## Chrome extension (Agent E) — `extension/`

Manifest V3, name "Real Estate Booster Capture". Permissions: `activeTab`, `scripting`, `storage`; host_permissions: `http://localhost:3210/*`. NO broad site permissions — activeTab is granted on click.
- Toolbar popup (`popup.html/js`): on open, injects `content.js` into the active tab via `chrome.scripting.executeScript`, receives extracted `{url, source_site, title, price_eur, size_m2, lat, lon, location_text, description, images, owner_contact}`; shows an editable form prefilled with whatever was parsed (fields may be empty — parsing is best-effort); country select (9 options + auto); "Save to Booster" → POST `http://localhost:3210/api/lands/capture`; show success (id + computed distance/future price from response) or error. Also a keyboard shortcut (`commands`: Alt+S opens the popup — `_execute_action`).
- `content.js` extraction order: (1) JSON-LD `application/ld+json` blocks (Offer/Product/RealEstateListing: price, name, geo), (2) OpenGraph meta (og:title, og:description, og:image), (3) site-specific selectors for known portals (halooglasi.com, 4zida.rs, nekretnine.rs, njuskalo.hr, realitica.com, nepremicnine.net, nehnutelnosti.sk, olx.ba, merrjep.al, pazar3.mk, spitogatos.gr, xe.gr — best-effort, wrapped in try/catch each), (4) generic regex over `document.body.innerText` for price (`€|EUR|din|km²`-aware: `([\d.,]+)\s*(€|EUR)`) and size (`([\d.,]+)\s*(m2|m²|ha|ari|ár)` — convert ha ×10000, ari ×100), (5) Facebook: if host contains facebook.com, take the post text nearest to selection or the first `[role=article]` innerText as description. Always include `document.title` and `location.href`. Never throws — returns whatever it found.
- `extension/README.md`: load-unpacked instructions.

## Conventions

- Every route file exports an `express.Router()`; `index.js` mounts them under `/api/<name>` (roads router also serves `/api/refresh/status`).
- Services never import routes. Routes import services and `../db`.
- Long-running work (refreshes) always goes through scheduler job guard so only one runs at a time.
- Log EVERY outbound HTTP call via `logApi`.
- Keep code plain and readable; comments only where the intent isn't obvious (Overpass QL, geo math).
