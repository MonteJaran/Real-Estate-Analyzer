// Buyers API: buyer categories/companies from buyers.json + matching a land to buyers.
// buyers.json is read fresh from disk on every request (it gets updated while the server runs).
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();

const BUYERS_PATH = path.join(__dirname, '..', 'data', 'buyers.json');

// Sector id → buyer category names. buyers.json ships its own exact mapping
// (sector_categories); this constant is only the fallback when it's absent.
const SECTOR_CATEGORIES = {
  'fuel-ev': ['fuel-gas-station', 'ev-charging-hub', 'truck-stop-rest-area'],
  'retail-food': ['drive-thru-fast-food', 'supermarket-discounter', 'retail-park'],
  'hotel-rest': ['roadside-motel-hotel'],
  'auto-logistics': ['car-dealership', 'logistics-warehouse'],
};

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

function readBuyers() {
  return JSON.parse(fs.readFileSync(BUYERS_PATH, 'utf8'));
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim();
}

function loosely(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// True when the land satisfies a category's size and distance criteria.
// Each criterion only applies when both sides of the comparison are known.
function categoryMatches(land, cat) {
  if (land.size_m2 != null && cat.min_size_m2 != null && cat.max_size_m2 != null) {
    if (land.size_m2 < cat.min_size_m2 || land.size_m2 > cat.max_size_m2) return false;
  }
  if (land.distance_to_road_m != null && cat.max_distance_from_road_m != null) {
    if (land.distance_to_road_m > cat.max_distance_from_road_m) return false;
  }
  return true;
}

// Category names a company's sector maps to (loose matching on sector id and category names).
function sectorCategoryNames(sector) {
  const out = [];
  for (const key of Object.keys(SECTOR_CATEGORIES)) {
    const cats = SECTOR_CATEGORIES[key];
    if (loosely(sector, key) || cats.some((c) => loosely(sector, c))) {
      out.push(...cats);
    }
  }
  return out;
}

function parseLand(row) {
  const out = Object.assign({}, row);
  try { out.images = row.images ? JSON.parse(row.images) : null; } catch (e) { /* keep raw string */ }
  try { out.raw = row.raw ? JSON.parse(row.raw) : null; } catch (e) { /* keep raw string */ }
  return out;
}

// GET /api/buyers → contents of buyers.json
router.get('/', (req, res) => {
  try {
    res.json(readBuyers());
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/buyers/match/:landId → {land, categories, companies}
router.get('/match/:landId', (req, res) => {
  try {
    const id = Number(req.params.landId);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'land not found' });
    const land = db.getDb().prepare('SELECT * FROM lands WHERE id = ?').get(id);
    if (!land) return res.status(404).json({ error: 'land not found' });

    const buyers = readBuyers();
    const allCategories = Array.isArray(buyers.categories) ? buyers.categories : [];
    const allCompanies = Array.isArray(buyers.companies) ? buyers.companies : [];

    const categories = allCategories.filter((cat) => categoryMatches(land, cat));
    const matchedNames = categories.map((c) => c.category);

    const landCountry = land.country ? String(land.country).toUpperCase() : null;
    const companies = allCompanies.filter((co) => {
      if (!landCountry) return false;
      const countries = Array.isArray(co.countries) ? co.countries.map((c) => String(c).toUpperCase()) : [];
      if (!countries.includes(landCountry)) return false;
      const mapped = sectorCategoryNames(co.sector);
      return mapped.some((m) => matchedNames.some((n) => loosely(n, m)));
    });

    res.json({ land: parseLand(land), categories, companies });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
