// Settings API: key/value settings; google_api_key is always masked in responses.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const MASKED_KEYS = ['google_api_key'];

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

function mask(value) {
  if (value == null || value === '') return value;
  const s = String(value);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

function maskedMap() {
  const rows = db.getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    out[r.key] = MASKED_KEYS.includes(r.key) ? mask(r.value) : r.value;
  }
  return out;
}

// GET /api/settings → {key: value} with google_api_key masked to last 4 chars
router.get('/', (req, res) => {
  try {
    res.json(maskedMap());
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/settings — body {key: value, ...}; returns the updated masked map
router.put('/', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be a JSON object of {key: value}' });
    }
    for (const key of Object.keys(body)) {
      const value = body[key];
      // Ignore a masked value echoed back from GET so it never overwrites the real key.
      if (MASKED_KEYS.includes(key) && typeof value === 'string' && value.startsWith('****')) continue;
      db.setSetting(key, value);
    }
    res.json(maskedMap());
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
