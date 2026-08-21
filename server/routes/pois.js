// POIs API: list stored points of interest, trigger a background refresh per country.
'use strict';

const express = require('express');
const db = require('../db');
const scheduler = require('../services/scheduler');

const router = express.Router();

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

// GET /api/pois?country=&kind=&road_id= → array of rows
router.get('/', (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.country) { where.push('country = ?'); params.push(String(req.query.country).toUpperCase()); }
    if (req.query.kind) { where.push('kind = ?'); params.push(String(req.query.kind)); }
    if (req.query.road_id) {
      const roadId = Number(req.query.road_id);
      if (Number.isInteger(roadId)) { where.push('near_road_id = ?'); params.push(roadId); }
    }
    const sql = 'SELECT * FROM pois' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id';
    const rows = db.getDb().prepare(sql).all(...params).map((row) => {
      const out = Object.assign({}, row);
      try { out.tags = row.tags ? JSON.parse(row.tags) : null; } catch (e) { /* keep raw string */ }
      return out;
    });
    res.json(rows);
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/pois/refresh {country} → 202 background job, 409 if one is running
router.post('/refresh', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.country) return res.status(400).json({ error: 'country required' });
    const country = String(body.country).toUpperCase();
    const status = scheduler.getStatus();
    if (status && status.running) {
      return res.status(409).json({ error: 'a refresh job is already running', running: status.running });
    }
    scheduler.refreshPois(country); // fire and forget
    const after = scheduler.getStatus();
    const running = (after && after.running) || { type: 'pois', country, startedAt: db.nowIso() };
    res.status(202).json({ started: true, running });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
