// Announcements API: scraped road-related links, newest first; background refresh trigger.
'use strict';

const express = require('express');
const db = require('../db');
const scheduler = require('../services/scheduler');

const router = express.Router();

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

// GET /api/announcements?country= → rows newest first
router.get('/', (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.country) {
      where.push('country = ?');
      params.push(String(req.query.country).toUpperCase());
    }
    const sql =
      'SELECT * FROM announcements' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY found_at DESC, id DESC';
    res.json(db.getDb().prepare(sql).all(...params));
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/announcements/refresh {country?} → 202 background job, 409 if one is running
router.post('/refresh', (req, res) => {
  try {
    const body = req.body || {};
    const country = body.country ? String(body.country).toUpperCase() : null;
    const status = scheduler.getStatus();
    if (status && status.running) {
      return res.status(409).json({ error: 'a refresh job is already running', running: status.running });
    }
    scheduler.refreshAnnouncements(country); // fire and forget
    const after = scheduler.getStatus();
    const running = (after && after.running) || { type: 'announcements', country, startedAt: db.nowIso() };
    res.status(202).json({ started: true, running });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
