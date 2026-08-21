// Billboards API: placement rules/economics config + ranked land suggestions.
'use strict';

const express = require('express');
const billboard = require('../services/billboard');

const router = express.Router();

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

// GET /api/billboards → billboards.json (rules, rates, strategy)
router.get('/', (req, res) => {
  try {
    res.json(billboard.loadConfig());
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/billboards/suggest?country=RS&all=1 → {considered, suggestions}
router.get('/suggest', (req, res) => {
  try {
    const country = req.query.country ? String(req.query.country).toUpperCase() : null;
    const includeUnsuitable = req.query.all === '1';
    res.json(billboard.suggest(country, includeUnsuitable));
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
