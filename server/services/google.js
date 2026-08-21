// Optional Google Places (New) enrichment — off unless a key is stored in settings.
// Hard monthly cap enforced from api_log before every call.
'use strict';

const db = require('../db');
const geo = require('./geo');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const INCLUDED_TYPES = ['gas_station', 'lodging', 'restaurant', 'supermarket', 'car_dealer'];
const RADIUS_M = 5000;
const TIMEOUT_MS = 30000;

function isEnabled() {
  return !!db.getSetting('google_api_key');
}

function monthlyCalls() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const row = db
    .getDb()
    .prepare("SELECT COUNT(*) AS n FROM api_log WHERE api_name = 'google_places' AND ts >= ?")
    .get(monthStart);
  return row ? row.n : 0;
}

function placeKind(types) {
  const t = new Set(types || []);
  if (t.has('gas_station')) return 'fuel';
  if (t.has('electric_vehicle_charging_station')) return 'charging';
  if (t.has('fast_food_restaurant')) return 'fast_food';
  if (t.has('restaurant')) return 'restaurant';
  if (t.has('lodging') || t.has('hotel') || t.has('motel')) return 'hotel';
  if (t.has('supermarket') || t.has('grocery_store')) return 'supermarket';
  if (t.has('car_dealer')) return 'car_dealer';
  return 'other';
}

// Nearby Search around the midpoint of every stored road of a country.
// Returns {country, calls, added, capped, note?}.
async function enrichPois(iso2) {
  if (!isEnabled()) {
    return { country: iso2, calls: 0, added: 0, capped: false, note: 'google_api_key not set' };
  }
  const key = db.getSetting('google_api_key');
  const cap = parseInt(db.getSetting('google_monthly_cap', '5000'), 10) || 5000;
  const roads = db.getDb().prepare('SELECT id, geometry FROM roads WHERE country = ?').all(iso2);
  const upsert = db.getDb().prepare(
    `INSERT INTO pois (osm_id, name, kind, country, lat, lon, near_road_id, distance_m, tags, source, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(osm_id) DO UPDATE SET
       name=excluded.name, kind=excluded.kind, country=excluded.country,
       lat=excluded.lat, lon=excluded.lon, near_road_id=excluded.near_road_id,
       distance_m=excluded.distance_m, tags=excluded.tags, source=excluded.source,
       updated_at=excluded.updated_at`
  );

  let calls = 0;
  let added = 0;
  let capped = false;

  for (const road of roads) {
    if (monthlyCalls() >= cap) {
      capped = true;
      break;
    }
    let coords;
    try {
      coords = JSON.parse(road.geometry);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(coords) || coords.length === 0) continue;
    const mid = coords[Math.floor(coords.length / 2)];
    const endpoint = `searchNearby ${iso2} road ${road.id}`;
    const start = Date.now();
    try {
      const res = await fetch(PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types',
        },
        body: JSON.stringify({
          includedTypes: INCLUDED_TYPES,
          maxResultCount: 20,
          locationRestriction: {
            circle: { center: { latitude: mid[0], longitude: mid[1] }, radius: RADIUS_M },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      calls++;
      if (!res.ok) {
        db.logApi('google_places', endpoint, false, Date.now() - start, 0, 'HTTP ' + res.status);
        continue;
      }
      const json = await res.json();
      const places = json.places || [];
      db.logApi('google_places', endpoint, true, Date.now() - start, places.length, null);
      for (const p of places) {
        if (!p.id || !p.location) continue;
        const lat = p.location.latitude;
        const lon = p.location.longitude;
        if (lat == null || lon == null) continue;
        const distance = Math.round(geo.pointToLineDistanceM(lat, lon, coords));
        upsert.run(
          'google/' + p.id,
          (p.displayName && p.displayName.text) || null,
          placeKind(p.types),
          iso2,
          lat,
          lon,
          road.id,
          distance,
          JSON.stringify({ types: p.types || [] }),
          'google',
          db.nowIso()
        );
        added++;
      }
    } catch (e) {
      calls++;
      db.logApi('google_places', endpoint, false, Date.now() - start, 0, e.message);
    }
  }

  return { country: iso2, calls, added, capped };
}

module.exports = { isEnabled, enrichPois };
