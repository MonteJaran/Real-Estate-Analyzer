// Status API: aggregated api_log stats per API, scheduler state, per-source scrape stats.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const scheduler = require('../services/scheduler');

const router = express.Router();

const COUNTRIES_PATH = path.join(__dirname, '..', 'data', 'countries.json');

const LIMIT_NOTES = {
  overpass: '~10k/day fair use, throttled 3s between calls',
  google_places: 'free tier: 5000 calls/mo hard stop (configurable)',
};

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

function readCountries() {
  return JSON.parse(fs.readFileSync(COUNTRIES_PATH, 'utf8'));
}

// Aggregate api_log per api_name: today/month counts via ISO ts prefix comparison.
function collectStats() {
  const d = db.getDb();
  const now = db.nowIso();
  const today = now.slice(0, 10); // YYYY-MM-DD
  const month = now.slice(0, 7);  // YYYY-MM
  const rows = d.prepare(`
    SELECT api_name,
           MAX(ts) AS last_call_ts,
           SUM(CASE WHEN substr(ts, 1, 10) = ? THEN 1 ELSE 0 END) AS calls_today,
           SUM(CASE WHEN substr(ts, 1, 7) = ? THEN 1 ELSE 0 END) AS calls_month,
           SUM(CASE WHEN substr(ts, 1, 7) = ? THEN COALESCE(items, 0) ELSE 0 END) AS items_month,
           AVG(CASE WHEN substr(ts, 1, 7) = ? THEN ok END) AS ok_rate_month
    FROM api_log
    GROUP BY api_name
  `).all(today, month, month, month);

  const lastStmt = d.prepare('SELECT ok, items FROM api_log WHERE api_name = ? ORDER BY ts DESC, id DESC LIMIT 1');
  const map = {};
  for (const r of rows) {
    const last = lastStmt.get(r.api_name);
    map[r.api_name] = {
      api_name: r.api_name,
      last_call_ts: r.last_call_ts,
      last_ok: last ? last.ok : null,
      last_items: last ? last.items : null,
      calls_today: r.calls_today || 0,
      calls_month: r.calls_month || 0,
      items_month: r.items_month || 0,
      ok_rate_month: r.ok_rate_month == null ? null : Math.round(r.ok_rate_month * 1000) / 1000,
    };
  }
  return map;
}

function emptyStats(apiName) {
  return {
    api_name: apiName,
    last_call_ts: null,
    last_ok: null,
    last_items: null,
    calls_today: 0,
    calls_month: 0,
    items_month: 0,
    ok_rate_month: null,
  };
}

// GET /api/status → {apis, scheduler, sources}
router.get('/', (req, res) => {
  try {
    const stats = collectStats();

    // apis: every non-source api_name seen in the log; overpass & google_places always listed.
    const apiNames = Object.keys(stats).filter((n) => !n.startsWith('source:'));
    for (const forced of ['overpass', 'google_places']) {
      if (!apiNames.includes(forced)) apiNames.push(forced);
    }
    apiNames.sort();
    const apis = apiNames.map((name) => {
      const s = stats[name] || emptyStats(name);
      return {
        api_name: s.api_name,
        last_call_ts: s.last_call_ts,
        last_ok: s.last_ok,
        calls_today: s.calls_today,
        calls_month: s.calls_month,
        items_month: s.items_month,
        ok_rate_month: s.ok_rate_month,
        limit_note: LIMIT_NOTES[name] || null,
      };
    });

    // sources: road_sources flattened across countries + their scrape stats.
    const sources = [];
    const config = readCountries();
    for (const c of config.countries || []) {
      for (const src of c.road_sources || []) {
        const apiName = `source:${c.iso2}:${src.name}`;
        const s = stats[apiName] || emptyStats(apiName);
        sources.push({
          country: c.iso2,
          country_name: c.name,
          name: src.name,
          url: src.url,
          kind: src.kind,
          scrape_method: src.scrape_method,
          language: src.language,
          verified: src.verified,
          api_name: apiName,
          last_call_ts: s.last_call_ts,
          last_ok: s.last_ok,
          last_items: s.last_items,
          calls_month: s.calls_month,
          items_month: s.items_month,
          ok_rate_month: s.ok_rate_month,
        });
      }
    }

    res.json({ apis, scheduler: scheduler.getStatus(), sources });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/status/log?api_name=&limit=100 → recent api_log rows, newest first
router.get('/log', (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = 100;
    if (limit > 1000) limit = 1000;
    const where = [];
    const params = [];
    if (req.query.api_name) {
      where.push('api_name = ?');
      params.push(String(req.query.api_name));
    }
    const sql =
      'SELECT * FROM api_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY ts DESC, id DESC LIMIT ?';
    const rows = db.getDb().prepare(sql).all(...params, limit);
    res.json(rows);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
