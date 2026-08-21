// Background job orchestration. One job at a time (in-memory guard), progress
// lines in an in-memory log (cap 50), cron every other day at 06:00 plus a
// startup catch-up. A failed country never kills the whole loop.
'use strict';

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('../db');
const geo = require('./geo');
const overpass = require('./overpass');
const roadsources = require('./roadsources');
const pricing = require('./pricing');

const CRON_PATTERN = '0 6 */2 * *';
const LOG_CAP = 50;
const STALE_ROAD_DAYS = 30;
const CATCHUP_AFTER_MS = 15000;
const CATCHUP_MAX_AGE_MS = 2 * 86400000; // 2 days

const state = {
  running: null, // {type, country, startedAt, log: [...]} | null
  lastJob: null, // same shape + finishedAt, kept so the UI can show the last log
};
let jobPromise = null; // resolves when the current background job finishes
let cronTask = null;

function loadCountries() {
  const p = path.join(__dirname, '..', 'data', 'countries.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).countries || [];
}

function pushLog(line) {
  if (!state.running) return;
  state.running.log.push(`${db.nowIso()} ${line}`);
  if (state.running.log.length > LOG_CAP) {
    state.running.log.splice(0, state.running.log.length - LOG_CAP);
  }
}

// '0 6 */2 * *' fires at 06:00 on days-of-month 1,3,5,... (cron step from 1).
function nextCronRun() {
  const now = new Date();
  for (let i = 0; i <= 62; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 6, 0, 0, 0);
    if (d > now && d.getDate() % 2 === 1) return d.toISOString();
  }
  return null;
}

function getStatus() {
  const counts = {};
  try {
    const rows = db
      .getDb()
      .prepare('SELECT country, status, COUNT(*) AS n FROM roads GROUP BY country, status')
      .all();
    for (const row of rows) {
      if (!counts[row.country]) counts[row.country] = { construction: 0, proposed: 0, total: 0 };
      counts[row.country][row.status] = row.n;
      counts[row.country].total += row.n;
    }
  } catch (e) {
    // status must never throw
  }
  return {
    running: state.running,
    lastJob: state.lastJob,
    lastRun: {
      roads: db.getSetting('last_refresh_roads'),
      pois: db.getSetting('last_refresh_pois'),
      announcements: db.getSetting('last_refresh_announcements'),
    },
    nextCronRun: nextCronRun(),
    roadCounts: counts,
  };
}

// Guard: only one job at a time. Returns {started, running} synchronously;
// the work itself runs in the background (routes answer 202/409 off `started`).
function startJob(type, country, work) {
  if (state.running) return { started: false, running: state.running };
  state.running = { type, country: country || null, startedAt: db.nowIso(), log: [] };
  const running = state.running;
  jobPromise = (async () => {
    try {
      await work();
      pushLog(`${type} job finished`);
    } catch (e) {
      pushLog(`${type} job FAILED: ${e.message}`);
    } finally {
      running.finishedAt = db.nowIso();
      state.lastJob = running;
      state.running = null;
    }
  })();
  return { started: true, running };
}

// ---------------------------------------------------------------- roads

function refreshRoads(iso2OrNull) {
  return startJob('roads', iso2OrNull || null, () => doRefreshRoads(iso2OrNull || null));
}

async function doRefreshRoads(iso2OrNull) {
  const all = loadCountries();
  const targets = iso2OrNull
    ? all.filter((c) => c.iso2 === iso2OrNull)
    : all.filter((c) => c.enabled);
  if (!targets.length) {
    pushLog(`no matching enabled country for "${iso2OrNull}"`);
    return;
  }
  for (const c of targets) {
    try {
      await refreshRoadsForCountry(c.iso2, !!c.major_roads_only);
    } catch (e) {
      pushLog(`[${c.iso2}] FAILED: ${e.message}`);
    }
  }
  try {
    const n = recomputeAllLands();
    pushLog(`recomputed nearest road / future price for ${n} lands`);
  } catch (e) {
    pushLog(`lands recompute FAILED: ${e.message}`);
  }
  db.setSetting('last_refresh_roads', db.nowIso());
}

async function refreshRoadsForCountry(iso2, majorOnly) {
  const d = db.getDb();
  pushLog(`[${iso2}] fetching construction/proposed roads from Overpass${majorOnly ? ' (major roads only)' : ''}...`);
  const ways = await overpass.fetchRoads(iso2, majorOnly);
  pushLog(`[${iso2}] ${ways.length} ways received, upserting...`);

  const now = db.nowIso();
  const upsert = d.prepare(
    `INSERT INTO roads
       (osm_id, country, name, ref, road_type, status, length_m, geometry, tags, source,
        min_lat, min_lon, max_lat, max_lon, first_seen, last_seen, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(osm_id) DO UPDATE SET
       country=excluded.country, name=excluded.name, ref=excluded.ref,
       road_type=excluded.road_type, status=excluded.status, length_m=excluded.length_m,
       geometry=excluded.geometry, tags=excluded.tags,
       min_lat=excluded.min_lat, min_lon=excluded.min_lon,
       max_lat=excluded.max_lat, max_lon=excluded.max_lon,
       last_seen=excluded.last_seen, updated_at=excluded.updated_at`
  );
  const getId = d.prepare('SELECT id FROM roads WHERE osm_id = ?');
  const delPoints = d.prepare('DELETE FROM road_points WHERE road_id = ?');
  const insPoint = d.prepare('INSERT INTO road_points (road_id, seq, lat, lon) VALUES (?,?,?,?)');

  d.exec('BEGIN');
  try {
    for (const w of ways) {
      const bbox = geo.bboxOf(w.coords, 0);
      upsert.run(
        w.osm_id,
        iso2,
        w.name,
        w.ref,
        w.road_type,
        w.status,
        Math.round(geo.lineLengthM(w.coords)),
        JSON.stringify(w.coords),
        JSON.stringify(w.tags || {}),
        'overpass',
        bbox.minLat,
        bbox.minLon,
        bbox.maxLat,
        bbox.maxLon,
        now, // first_seen — preserved on conflict (not in the UPDATE set)
        now,
        now
      );
      const id = getId.get(w.osm_id).id;
      delPoints.run(id);
      const pts = geo.interpolateEveryM(w.coords, 100);
      for (let s = 0; s < pts.length; s++) insPoint.run(id, s, pts[s].lat, pts[s].lon);
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }

  const cutoff = new Date(Date.now() - STALE_ROAD_DAYS * 86400000).toISOString();
  const del = d.prepare('DELETE FROM roads WHERE country = ? AND last_seen < ?').run(iso2, cutoff);
  if (del.changes) pushLog(`[${iso2}] removed ${del.changes} roads not seen in ${STALE_ROAD_DAYS} days`);

  pushLog(`[${iso2}] fetching junction nodes with the existing network...`);
  let junctions = [];
  try {
    junctions = await overpass.fetchConnections(iso2, majorOnly);
  } catch (e) {
    pushLog(`[${iso2}] connections fetch failed: ${e.message} — keeping endpoints only`);
  }

  const countryRoads = d
    .prepare('SELECT id, geometry, min_lat, min_lon, max_lat, max_lon FROM roads WHERE country = ?')
    .all(iso2);
  const parsed = [];
  for (const r of countryRoads) {
    try {
      const coords = JSON.parse(r.geometry);
      if (Array.isArray(coords) && coords.length >= 2) parsed.push({ row: r, coords });
    } catch (e) {
      // skip unparsable geometry
    }
  }

  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM road_connections WHERE road_id IN (SELECT id FROM roads WHERE country = ?)').run(iso2);
    const insConn = d.prepare('INSERT INTO road_connections (road_id, lat, lon, kind, note) VALUES (?,?,?,?,?)');
    let connCount = 0;
    for (const r of parsed) {
      const first = r.coords[0];
      const last = r.coords[r.coords.length - 1];
      insConn.run(r.row.id, first[0], first[1], 'endpoint', 'road start');
      insConn.run(r.row.id, last[0], last[1], 'endpoint', 'road end');
      connCount += 2;
    }
    const MATCH_M = 100;
    const latPad = MATCH_M / 111320;
    for (const n of junctions) {
      const lonPad = MATCH_M / (111320 * Math.max(0.1, Math.cos((n.lat * Math.PI) / 180)));
      let best = null;
      for (const r of parsed) {
        if (n.lat < r.row.min_lat - latPad || n.lat > r.row.max_lat + latPad) continue;
        if (n.lon < r.row.min_lon - lonPad || n.lon > r.row.max_lon + lonPad) continue;
        const dist = geo.pointToLineDistanceM(n.lat, n.lon, r.coords);
        if (dist <= MATCH_M && (!best || dist < best.dist)) best = { id: r.row.id, dist };
      }
      if (best) {
        insConn.run(best.id, n.lat, n.lon, 'junction_existing', n.note || 'touches existing road');
        connCount++;
      }
    }
    d.exec('COMMIT');
    pushLog(`[${iso2}] ${parsed.length} roads stored, ${connCount} connection points`);
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// Same logic as POST /api/lands/recompute: nearest road, distance, future price
// for every land with coordinates.
function recomputeAllLands() {
  const d = db.getDb();
  const lands = d.prepare('SELECT * FROM lands WHERE lat IS NOT NULL AND lon IS NOT NULL').all();
  const upd = d.prepare(
    'UPDATE lands SET nearest_road_id=?, distance_to_road_m=?, future_price_eur=?, future_price_note=?, updated_at=? WHERE id=?'
  );
  let n = 0;
  for (const land of lands) {
    const nr = geo.nearestRoad(land.lat, land.lon);
    const distance = nr ? nr.distance_m : null;
    const est = pricing.estimate(
      Object.assign({}, land, { distance_to_road_m: distance }),
      nr ? nr.road : null
    );
    upd.run(nr ? nr.road_id : null, distance, est.future_price_eur, est.note, db.nowIso(), land.id);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- pois

function refreshPois(iso2) {
  if (!iso2) return { started: false, running: state.running, error: 'country required' };
  return startJob('pois', iso2, () => doRefreshPois(iso2));
}

async function doRefreshPois(iso2) {
  const d = db.getDb();
  const roads = d
    .prepare('SELECT id, geometry, min_lat, min_lon, max_lat, max_lon FROM roads WHERE country = ?')
    .all(iso2);
  if (!roads.length) {
    pushLog(`[${iso2}] no stored roads — run a road refresh first`);
    return;
  }
  const parsed = [];
  for (const r of roads) {
    try {
      const coords = JSON.parse(r.geometry);
      if (Array.isArray(coords) && coords.length >= 1) parsed.push({ row: r, coords });
    } catch (e) {
      // skip
    }
  }
  pushLog(`[${iso2}] fetching POIs within 5 km of ${parsed.length} roads...`);
  const pois = await overpass.fetchPoisNear(parsed.map((r) => r.coords));
  pushLog(`[${iso2}] ${pois.length} POIs received, upserting...`);

  const upsert = d.prepare(
    `INSERT INTO pois (osm_id, name, kind, country, lat, lon, near_road_id, distance_m, tags, source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(osm_id) DO UPDATE SET
       name=excluded.name, kind=excluded.kind, country=excluded.country,
       lat=excluded.lat, lon=excluded.lon, near_road_id=excluded.near_road_id,
       distance_m=excluded.distance_m, tags=excluded.tags, source=excluded.source,
       updated_at=excluded.updated_at`
  );
  const PAD_M = 6000; // POIs come from a 5 km radius; a hair extra for bbox slop
  const latPad = PAD_M / 111320;
  let saved = 0;
  for (const p of pois) {
    const lonPad = PAD_M / (111320 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180)));
    let best = null;
    for (const r of parsed) {
      if (p.lat < r.row.min_lat - latPad || p.lat > r.row.max_lat + latPad) continue;
      if (p.lon < r.row.min_lon - lonPad || p.lon > r.row.max_lon + lonPad) continue;
      const dist = geo.pointToLineDistanceM(p.lat, p.lon, r.coords);
      if (!best || dist < best.dist) best = { id: r.row.id, dist };
    }
    upsert.run(
      p.osm_id,
      p.name,
      p.kind,
      iso2,
      p.lat,
      p.lon,
      best ? best.id : null,
      best ? Math.round(best.dist) : null,
      JSON.stringify(p.tags || {}),
      'overpass',
      db.nowIso()
    );
    saved++;
  }
  pushLog(`[${iso2}] ${saved} POIs upserted`);
  db.setSetting('last_refresh_pois', db.nowIso());
}

// ---------------------------------------------------------------- announcements

function refreshAnnouncements(iso2OrNull) {
  return startJob('announcements', iso2OrNull || null, () => doRefreshAnnouncements(iso2OrNull || null));
}

async function doRefreshAnnouncements(iso2OrNull) {
  const all = loadCountries();
  const targets = iso2OrNull
    ? all.filter((c) => c.iso2 === iso2OrNull)
    : all.filter((c) => c.enabled);
  let total = 0;
  for (const c of targets) {
    try {
      pushLog(`[${c.iso2}] scraping ${(c.road_sources || []).length} announcement sources...`);
      const r = await roadsources.refreshAnnouncements(c);
      total += r.newCount;
      pushLog(`[${c.iso2}] ${r.newCount} new announcements`);
    } catch (e) {
      pushLog(`[${c.iso2}] announcements FAILED: ${e.message}`);
    }
  }
  pushLog(`announcements refresh done — ${total} new in total`);
  db.setSetting('last_refresh_announcements', db.nowIso());
}

// ---------------------------------------------------------------- init

function init() {
  if (cronTask) return;
  cronTask = cron.schedule(CRON_PATTERN, async () => {
    try {
      const r = refreshRoads(null);
      if (r.started) await jobPromise;
      const a = refreshAnnouncements(null);
      if (a.started) await jobPromise;
    } catch (e) {
      // a failed scheduled run must never throw
    }
  });
  // startup catch-up: refresh if never run or older than 2 days
  const t = setTimeout(() => {
    try {
      const last = db.getSetting('last_refresh_roads');
      const age = last ? Date.now() - Date.parse(last) : Infinity;
      if ((!last || !isFinite(age) || age > CATCHUP_MAX_AGE_MS) && !state.running) {
        refreshRoads(null);
      }
    } catch (e) {
      // ignore
    }
  }, CATCHUP_AFTER_MS);
  if (typeof t.unref === 'function') t.unref();
}

module.exports = { init, getStatus, refreshRoads, refreshPois, refreshAnnouncements };
