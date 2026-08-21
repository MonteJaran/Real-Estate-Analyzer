// Overpass API client. ALL calls are serialized through one internal promise-chain
// queue with >=3000 ms between request starts (fair-use throttling). Endpoints
// rotate on failure. Every HTTP call is logged via db.logApi('overpass', ...).
'use strict';

const db = require('../db');
const geo = require('./geo');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const MIN_GAP_MS = 3000;
const TIMEOUT_MS = 90000;
const RETRY_PAUSE_MS = 8000; // extra wait after a failed attempt (429s clear quickly)
// A User-Agent is required politeness — overpass-api.de rate-limits anonymous clients hard.
const USER_AGENT = 'RealEstateBooster/1.0 (personal research tool)';

let endpointIdx = 0;
let chain = Promise.resolve(); // the serialization queue
let lastStart = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Push a task onto the queue; it runs after every previously queued task,
// waiting so that consecutive request starts are >= MIN_GAP_MS apart.
function enqueue(task) {
  const run = async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return task();
  };
  const p = chain.then(run, run);
  chain = p.then(
    () => {},
    () => {}
  ); // failures must not break the queue
  return p;
}

async function attempt(url, ql, summary) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: 'data=' + encodeURIComponent(ql),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const items = Array.isArray(json.elements) ? json.elements.length : 0;
    db.logApi('overpass', summary, true, Date.now() - start, items, new URL(url).host);
    return json;
  } catch (e) {
    db.logApi('overpass', summary, false, Date.now() - start, 0, new URL(url).host + ': ' + e.message);
    throw e;
  }
}

// Run an Overpass QL query; on failure rotate to the next endpoint and retry once
// per endpoint. Each attempt goes through the throttled queue.
async function runQuery(ql, summary) {
  let lastErr = null;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const url = ENDPOINTS[endpointIdx];
    try {
      return await enqueue(() => attempt(url, ql, summary));
    } catch (e) {
      lastErr = e;
      endpointIdx = (endpointIdx + 1) % ENDPOINTS.length; // rotate on failure
      await sleep(RETRY_PAUSE_MS);
    }
  }
  throw lastErr;
}

// All highway=construction / highway=proposed ways in a country.
// majorOnly (big countries): only ways whose future class is motorway/trunk/primary —
// unfiltered queries for e.g. Germany would return tens of thousands of minor ways.
// Returns [{osm_id:'way/<id>', name, ref, road_type, status, coords:[[lat,lon],...], tags}].
async function fetchRoads(iso2, majorOnly) {
  const cFilter = majorOnly ? '["construction"~"^(motorway|trunk|primary)$"]' : '';
  const pFilter = majorOnly ? '["proposed"~"^(motorway|trunk|primary)$"]' : '';
  const ql = `[out:json][timeout:120];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
(
  way["highway"="construction"]${cFilter}(area.a);
  way["highway"="proposed"]${pFilter}(area.a);
);
out geom;`;
  const json = await runQuery(ql, `fetchRoads ${iso2}`);
  const out = [];
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    const status = tags.highway === 'proposed' ? 'proposed' : 'construction';
    // the future road class lives in the construction=* / proposed=* tag
    let roadType = status === 'proposed' ? tags.proposed : tags.construction;
    if (!roadType || roadType === 'yes') roadType = 'unknown';
    out.push({
      osm_id: 'way/' + el.id,
      name: tags.name || null,
      ref: tags.ref || null,
      road_type: roadType,
      status,
      coords: el.geometry.map((g) => [g.lat, g.lon]),
      tags,
    });
  }
  return out;
}

// Nodes shared between construction/proposed ways and the existing road network.
// Returns [{lat, lon, note: 'touches existing road'}], deduped by node id.
async function fetchConnections(iso2, majorOnly) {
  const byId = new Map();
  let okCount = 0;
  let firstErr = null;
  for (const hw of ['construction', 'proposed']) {
    const classFilter = majorOnly ? `["${hw}"~"^(motorway|trunk|primary)$"]` : '';
    const ql = `[out:json][timeout:120];
area["ISO3166-1"="${iso2}"][admin_level=2]->.a;
way[highway=${hw}]${classFilter}(area.a)->.c;
node(w.c)->.cn;
way(bn.cn)[highway][highway!~"construction|proposed"]->.x;
node(w.c)(w.x);
out;`;
    try {
      const json = await runQuery(ql, `fetchConnections ${iso2} ${hw}`);
      okCount++;
      for (const el of json.elements || []) {
        if (el.type !== 'node' || el.lat == null || el.lon == null) continue;
        byId.set(el.id, { lat: el.lat, lon: el.lon, note: 'touches existing road' });
      }
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
  }
  if (okCount === 0 && firstErr) throw firstErr;
  return Array.from(byId.values());
}

// Tag filters for POIs of interest around new roads.
const POI_FILTERS = [
  '["amenity"~"^(fuel|charging_station|restaurant|fast_food)$"]',
  '["tourism"~"^(hotel|motel)$"]',
  '["shop"~"^(supermarket|mall|car)$"]',
  '["landuse"="industrial"]',
];

function poiKind(tags) {
  if (tags.amenity === 'fuel') return 'fuel';
  if (tags.amenity === 'charging_station') return 'charging';
  if (tags.amenity === 'restaurant') return 'restaurant';
  if (tags.amenity === 'fast_food') return 'fast_food';
  if (tags.tourism === 'hotel' || tags.tourism === 'motel') return 'hotel';
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'car') return 'car_dealer';
  if (tags.shop === 'mall') return 'shop';
  if (tags.landuse === 'industrial') return 'industrial';
  return 'other';
}

const MAX_PTS_PER_POLYLINE = 60; // long roads are split into chunks
const MAX_PTS_PER_QUERY = 150; // several roads batched per query

// POIs within radiusM of the given road geometries. coordsList = [[[lat,lon],...], ...].
// Road geometry is downsampled to ~1 point per km (plenty for a 5 km around-radius),
// chunked, batched, and results are deduped by osm_id.
async function fetchPoisNear(coordsList, radiusM = 5000) {
  const polylines = [];
  for (const coords of coordsList || []) {
    if (!Array.isArray(coords) || coords.length === 0) continue;
    const pts =
      coords.length < 2
        ? [{ lat: coords[0][0], lon: coords[0][1] }]
        : geo.interpolateEveryM(coords, 1000);
    for (let i = 0; i < pts.length; i += MAX_PTS_PER_POLYLINE) {
      polylines.push(pts.slice(i, i + MAX_PTS_PER_POLYLINE));
    }
  }
  if (!polylines.length) return [];

  const batches = [];
  let cur = [];
  let curPts = 0;
  for (const pl of polylines) {
    if (cur.length && curPts + pl.length > MAX_PTS_PER_QUERY) {
      batches.push(cur);
      cur = [];
      curPts = 0;
    }
    cur.push(pl);
    curPts += pl.length;
  }
  if (cur.length) batches.push(cur);

  const seen = new Map();
  for (let b = 0; b < batches.length; b++) {
    const stmts = [];
    for (const pl of batches[b]) {
      const around = `(around:${radiusM},${pl
        .map((p) => p.lat.toFixed(6) + ',' + p.lon.toFixed(6))
        .join(',')})`;
      for (const f of POI_FILTERS) {
        stmts.push(`node${f}${around};`);
        stmts.push(`way${f}${around};`);
      }
    }
    const ql = `[out:json][timeout:90];\n(\n${stmts.join('\n')}\n);\nout center;`;
    const json = await runQuery(
      ql,
      `fetchPoisNear batch ${b + 1}/${batches.length} (${batches[b].length} segments)`
    );
    for (const el of json.elements || []) {
      const osmId = el.type + '/' + el.id;
      if (seen.has(osmId)) continue;
      const lat = el.lat != null ? el.lat : el.center ? el.center.lat : null;
      const lon = el.lon != null ? el.lon : el.center ? el.center.lon : null;
      if (lat == null || lon == null) continue;
      const tags = el.tags || {};
      seen.set(osmId, { osm_id: osmId, name: tags.name || null, kind: poiKind(tags), lat, lon, tags });
    }
  }
  return Array.from(seen.values());
}

module.exports = { fetchRoads, fetchConnections, fetchPoisNear };
