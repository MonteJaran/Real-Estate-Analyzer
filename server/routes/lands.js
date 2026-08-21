// Lands API: list/filter/sort, capture upsert (Chrome extension), manual add, patch, delete, recompute.
'use strict';

const express = require('express');
const db = require('../db');
const geo = require('../services/geo');
const pricing = require('../services/pricing');

const router = express.Router();

// All real columns of the lands table — the sort whitelist. NEVER interpolate
// user input into SQL identifiers outside this list.
const LAND_COLUMNS = [
  'id', 'url', 'source_site', 'title', 'country', 'lat', 'lon', 'location_text',
  'size_m2', 'price_eur', 'price_per_m2', 'contents', 'description', 'images',
  'contacted', 'contact_status', 'call_notes', 'owner_contact',
  'nearest_road_id', 'distance_to_road_m', 'future_price_eur', 'future_price_note',
  'raw', 'captured_at', 'updated_at',
];

// Fields accepted from capture / manual-add bodies.
const CAPTURE_FIELDS = [
  'url', 'source_site', 'title', 'price_eur', 'size_m2', 'lat', 'lon', 'country',
  'location_text', 'contents', 'description', 'images', 'owner_contact', 'raw',
];

// Fields accepted by PATCH.
const PATCH_FIELDS = [
  'contacted', 'contact_status', 'call_notes', 'owner_contact', 'title',
  'price_eur', 'size_m2', 'lat', 'lon', 'country', 'location_text', 'contents', 'description',
];

const NUMERIC_FIELDS = new Set(['price_eur', 'size_m2', 'lat', 'lon']);

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize one incoming field value for storage.
function normalizeValue(key, value) {
  if (value == null) return null;
  if (NUMERIC_FIELDS.has(key)) return toNumberOrNull(value);
  if (key === 'contacted') return Number(value) ? 1 : 0;
  if (key === 'images') return Array.isArray(value) ? JSON.stringify(value) : String(value);
  if (key === 'raw') return typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (key === 'country') return String(value).toUpperCase();
  return String(value);
}

// Parse stored JSON columns back into objects for responses.
function parseLand(row) {
  if (!row) return row;
  const out = Object.assign({}, row);
  try { out.images = row.images ? JSON.parse(row.images) : null; } catch (e) { /* keep raw string */ }
  try { out.raw = row.raw ? JSON.parse(row.raw) : null; } catch (e) { /* keep raw string */ }
  return out;
}

// Dynamic UPDATE limited to whitelisted columns.
function runUpdate(d, id, updates) {
  const cols = Object.keys(updates).filter((k) => LAND_COLUMNS.includes(k));
  if (!cols.length) return;
  const sql = 'UPDATE lands SET ' + cols.map((c) => c + ' = ?').join(', ') + ' WHERE id = ?';
  d.prepare(sql).run(...cols.map((c) => updates[c]), id);
}

// Dynamic INSERT limited to whitelisted columns (omitted columns keep their schema defaults).
function runInsert(d, fields) {
  const cols = Object.keys(fields).filter((k) => LAND_COLUMNS.includes(k) && fields[k] != null);
  const sql = 'INSERT INTO lands (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
  const info = d.prepare(sql).run(...cols.map((c) => fields[c]));
  return Number(info.lastInsertRowid);
}

// Derived fields: nearest road + distance, future price estimate, price per m².
function computeDerived(row) {
  const upd = {};
  if (row.lat != null && row.lon != null) {
    let near = null;
    try { near = geo.nearestRoad(row.lat, row.lon); } catch (e) { near = null; }
    upd.nearest_road_id = near ? near.road_id : null;
    upd.distance_to_road_m = near ? near.distance_m : null;
    let est = null;
    try { est = pricing.estimate(Object.assign({}, row, upd), near ? near.road : null); } catch (e) { est = null; }
    upd.future_price_eur = est && est.future_price_eur != null ? est.future_price_eur : null;
    upd.future_price_note = est && est.note != null ? est.note : null;
  } else {
    upd.nearest_road_id = null;
    upd.distance_to_road_m = null;
    upd.future_price_eur = null;
    upd.future_price_note = null;
  }
  const price = toNumberOrNull(row.price_eur);
  const size = toNumberOrNull(row.size_m2);
  upd.price_per_m2 = price != null && size != null && size > 0
    ? Math.round((price / size) * 100) / 100
    : null;
  return upd;
}

// Shared save logic for POST /capture and POST /  (upsert by url).
function saveLand(req, res, requireUrl) {
  try {
    const body = req.body || {};
    let url = body.url != null && String(body.url).trim() !== '' ? String(body.url).trim() : null;
    if (!url) {
      if (requireUrl) return res.status(400).json({ error: 'url required' });
      url = 'manual:' + Date.now();
    }

    const incoming = {};
    for (const key of CAPTURE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        incoming[key] = normalizeValue(key, body[key]);
      }
    }
    incoming.url = url;

    const d = db.getDb();
    const now = db.nowIso();
    const existing = d.prepare('SELECT * FROM lands WHERE url = ?').get(url);
    let id;
    if (existing) {
      // Update only non-null incoming fields.
      const updates = {};
      for (const key of Object.keys(incoming)) {
        if (key !== 'url' && incoming[key] != null) updates[key] = incoming[key];
      }
      updates.updated_at = now;
      runUpdate(d, existing.id, updates);
      id = existing.id;
    } else {
      incoming.captured_at = now;
      incoming.updated_at = now;
      id = runInsert(d, incoming);
    }

    let row = d.prepare('SELECT * FROM lands WHERE id = ?').get(id);
    const derived = computeDerived(row);
    if (row.country == null && row.lat != null && row.lon != null) {
      try { derived.country = geo.countryOf(row.lat, row.lon) || null; } catch (e) { /* nullable ok */ }
      // bbox lookup only covers the Balkans focus countries — elsewhere, inherit
      // the country of the nearest tracked road
      if (derived.country == null && derived.nearest_road_id != null) {
        try {
          const r = d.prepare('SELECT country FROM roads WHERE id = ?').get(derived.nearest_road_id);
          if (r) derived.country = r.country;
        } catch (e) { /* nullable ok */ }
      }
    }
    derived.updated_at = now;
    runUpdate(d, id, derived);
    row = d.prepare('SELECT * FROM lands WHERE id = ?').get(id);
    res.json(parseLand(row));
  } catch (err) {
    fail(res, err);
  }
}

// GET /api/lands — filters + sort + paging, returns {items, total}
router.get('/', (req, res) => {
  try {
    const q = req.query;
    const where = [];
    const params = [];
    if (q.country) { where.push('country = ?'); params.push(String(q.country).toUpperCase()); }
    if (q.contacted === '0' || q.contacted === '1') { where.push('contacted = ?'); params.push(Number(q.contacted)); }
    if (q.contact_status) { where.push('contact_status = ?'); params.push(String(q.contact_status)); }
    const minSize = toNumberOrNull(q.min_size);
    if (minSize != null) { where.push('size_m2 >= ?'); params.push(minSize); }
    const maxSize = toNumberOrNull(q.max_size);
    if (maxSize != null) { where.push('size_m2 <= ?'); params.push(maxSize); }
    const minPrice = toNumberOrNull(q.min_price);
    if (minPrice != null) { where.push('price_eur >= ?'); params.push(minPrice); }
    const maxPrice = toNumberOrNull(q.max_price);
    if (maxPrice != null) { where.push('price_eur <= ?'); params.push(maxPrice); }
    const maxDistance = toNumberOrNull(q.max_distance);
    if (maxDistance != null) { where.push('distance_to_road_m <= ?'); params.push(maxDistance); }
    if (q.q) {
      where.push('(title LIKE ? OR location_text LIKE ? OR description LIKE ?)');
      const like = '%' + String(q.q) + '%';
      params.push(like, like, like);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    // Sort column must come from the whitelist — never from raw user input.
    const sort = LAND_COLUMNS.includes(q.sort) ? q.sort : 'captured_at';
    const dir = String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    let limit = parseInt(q.limit, 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = 500;
    let offset = parseInt(q.offset, 10);
    if (!Number.isInteger(offset) || offset < 0) offset = 0;

    const d = db.getDb();
    const items = d
      .prepare(`SELECT * FROM lands${whereSql} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(parseLand);
    const totalRow = d.prepare(`SELECT COUNT(*) AS n FROM lands${whereSql}`).get(...params);
    res.json({ items, total: totalRow.n });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/lands/capture — extension capture, upsert by url (url required)
router.post('/capture', (req, res) => saveLand(req, res, true));

// POST /api/lands/recompute — recompute derived fields for all lands with coordinates
router.post('/recompute', (req, res) => {
  try {
    const d = db.getDb();
    const rows = d.prepare('SELECT * FROM lands WHERE lat IS NOT NULL AND lon IS NOT NULL').all();
    const now = db.nowIso();
    let updated = 0;
    for (const row of rows) {
      const derived = computeDerived(row);
      derived.updated_at = now;
      runUpdate(d, row.id, derived);
      updated++;
    }
    res.json({ updated });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/lands — manual entry, same as capture but url is generated when absent
router.post('/', (req, res) => saveLand(req, res, false));

// GET /api/lands/duplicates?radius=30&country= — groups of lands whose coordinates
// fall within `radius` meters of each other: the same plot captured from several
// portals/sellers. radius=0 means exactly identical lat/lon.
// NOTE: must be registered before GET /:id or "duplicates" would match :id.
router.get('/duplicates', (req, res) => {
  try {
    let radius = Number(req.query.radius);
    if (!Number.isFinite(radius) || radius < 0) radius = 30;
    const where = ['lat IS NOT NULL', 'lon IS NOT NULL'];
    const params = [];
    if (req.query.country) { where.push('country = ?'); params.push(String(req.query.country).toUpperCase()); }
    const rows = db.getDb().prepare(`SELECT * FROM lands WHERE ${where.join(' AND ')} ORDER BY id`).all(...params);

    // Greedy clustering — joins the first group with any member within radius.
    // Fine at personal-database scale (thousands of rows).
    const groups = [];
    for (const land of rows) {
      let placed = false;
      for (const g of groups) {
        if (g.some((m) => geo.haversineM(land.lat, land.lon, m.lat, m.lon) <= radius)) {
          g.push(land);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push([land]);
    }

    const out = groups.filter((g) => g.length > 1).map((g) => {
      const cLat = g.reduce((a, m) => a + m.lat, 0) / g.length;
      const cLon = g.reduce((a, m) => a + m.lon, 0) / g.length;
      let spread = 0;
      for (const m of g) spread = Math.max(spread, geo.haversineM(cLat, cLon, m.lat, m.lon));
      const prices = g.map((m) => m.price_eur).filter((p) => p != null);
      return {
        center: { lat: cLat, lon: cLon },
        spread_m: Math.round(spread),
        count: g.length,
        price_min: prices.length ? Math.min(...prices) : null,
        price_max: prices.length ? Math.max(...prices) : null,
        lands: g.map(parseLand),
      };
    });
    out.sort((a, b) => b.count - a.count);
    res.json({ radius, groups: out });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/lands/:id — full row with parsed images/raw
router.get('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'land not found' });
    const row = db.getDb().prepare('SELECT * FROM lands WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'land not found' });
    res.json(parseLand(row));
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/lands/:id — partial update of writable columns
router.patch('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'land not found' });
    const d = db.getDb();
    const existing = d.prepare('SELECT * FROM lands WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'land not found' });

    const body = req.body || {};
    const updates = {};
    for (const key of PATCH_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updates[key] = normalizeValue(key, body[key]);
      }
    }
    const now = db.nowIso();
    updates.updated_at = now;
    runUpdate(d, id, updates);

    // Recompute derived fields when location/price/size changed.
    const triggers = ['lat', 'lon', 'price_eur', 'size_m2'];
    if (triggers.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
      const row = d.prepare('SELECT * FROM lands WHERE id = ?').get(id);
      const derived = computeDerived(row);
      derived.updated_at = now;
      runUpdate(d, id, derived);
    }
    const row = d.prepare('SELECT * FROM lands WHERE id = ?').get(id);
    res.json(parseLand(row));
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/lands/:id
router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'land not found' });
    db.getDb().prepare('DELETE FROM lands WHERE id = ?').run(id);
    res.json({ deleted: true });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
