// Roads API. Mounted at /api (not /api/roads) because it also serves GET /api/refresh/status.
// Routes: GET /roads, GET /roads/:id, POST /roads/refresh, GET /refresh/status.
'use strict';

const express = require('express');
const db = require('../db');
const scheduler = require('../services/scheduler');

const router = express.Router();

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

// GET /api/roads?country=RS&status=construction → GeoJSON FeatureCollection (lon,lat!)
router.get('/roads', (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.country) {
      where.push('r.country = ?');
      params.push(String(req.query.country).toUpperCase());
    }
    if (req.query.status) {
      where.push('r.status = ?');
      params.push(String(req.query.status));
    }
    // bbox=minLat,minLon,maxLat,maxLon — viewport loading now that all of Europe is tracked
    if (req.query.bbox) {
      const b = String(req.query.bbox).split(',').map(Number);
      if (b.length === 4 && b.every(Number.isFinite)) {
        where.push('r.max_lat >= ? AND r.min_lat <= ? AND r.max_lon >= ? AND r.min_lon <= ?');
        params.push(b[0], b[2], b[1], b[3]);
      }
    }
    const sql =
      'SELECT r.*, (SELECT COUNT(*) FROM road_connections c WHERE c.road_id = r.id) AS connections_count ' +
      'FROM roads r' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    const rows = db.getDb().prepare(sql).all(...params);

    const features = [];
    for (const r of rows) {
      let coords;
      try {
        coords = JSON.parse(r.geometry); // stored as [[lat,lon],...]
      } catch (e) {
        continue; // skip unparseable geometry
      }
      if (!Array.isArray(coords) || coords.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords.map((p) => [p[1], p[0]]), // GeoJSON wants lon,lat
        },
        properties: {
          id: r.id,
          osm_id: r.osm_id,
          name: r.name,
          ref: r.ref,
          road_type: r.road_type,
          status: r.status,
          length_m: r.length_m,
          country: r.country,
          source: r.source,
          last_seen: r.last_seen,
          connections_count: r.connections_count,
        },
      });
    }
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/refresh/status → scheduler job state
router.get('/refresh/status', (req, res) => {
  try {
    res.json(scheduler.getStatus());
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/roads/refresh {country?} → 202 background job, 409 if one is running
router.post('/roads/refresh', (req, res) => {
  try {
    const body = req.body || {};
    const country = body.country ? String(body.country).toUpperCase() : null;
    const status = scheduler.getStatus();
    if (status && status.running) {
      return res.status(409).json({ error: 'a refresh job is already running', running: status.running });
    }
    scheduler.refreshRoads(country); // fire and forget
    const after = scheduler.getStatus();
    const running = (after && after.running) || { type: 'roads', country, startedAt: db.nowIso() };
    res.status(202).json({ started: true, running });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/roads/:id → full road with points and connections
router.get('/roads/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'road not found' });
    const d = db.getDb();
    const row = d.prepare('SELECT * FROM roads WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'road not found' });

    let geometry = [];
    let tags = {};
    try { geometry = JSON.parse(row.geometry) || []; } catch (e) { /* keep empty */ }
    try { tags = row.tags ? JSON.parse(row.tags) : {}; } catch (e) { /* keep empty */ }

    const points = d
      .prepare('SELECT seq, lat, lon FROM road_points WHERE road_id = ? ORDER BY seq')
      .all(id);
    const connections = d
      .prepare('SELECT id, lat, lon, kind, note FROM road_connections WHERE road_id = ? ORDER BY id')
      .all(id);

    res.json({
      road: Object.assign({}, row, { geometry, tags }),
      points,
      connections,
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
