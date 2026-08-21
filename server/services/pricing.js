// Future land price estimation: multiplier by nearest-road class and distance,
// with a bonus when a road access/connection point is close by.
'use strict';

const db = require('../db');
const geo = require('./geo');

// Distance bands (meters) → multiplier. First group: motorway/trunk, second: everything else.
function baseMultiplier(roadType, distanceM) {
  const major = roadType === 'motorway' || roadType === 'trunk';
  if (distanceM < 500) return major ? 3.0 : 2.2;
  if (distanceM < 1000) return major ? 2.2 : 1.8;
  if (distanceM < 2000) return major ? 1.7 : 1.4;
  if (distanceM < 3500) return major ? 1.35 : 1.2;
  if (distanceM <= 5000) return major ? 1.15 : 1.1;
  return 1.0; // beyond the 5 km influence zone
}

// Any road_connections point within radiusM of the land? (bbox prefilter + haversine)
function hasAccessPointNear(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const rows = db
    .getDb()
    .prepare('SELECT lat, lon FROM road_connections WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);
  return rows.some((r) => geo.haversineM(lat, lon, r.lat, r.lon) <= radiusM);
}

function roadLabel(road) {
  const name = road.ref || road.name || 'unnamed';
  const type = road.road_type && road.road_type !== 'unknown' ? road.road_type : 'road';
  return `${name} ${type}`;
}

// land: lands row (needs price_eur + distance_to_road_m; lat/lon used for the access bonus).
// road: roads row (or null). Returns {future_price_eur, note}.
function estimate(land, road) {
  const price = land ? land.price_eur : null;
  const dist = land ? land.distance_to_road_m : null;
  if (price == null || dist == null || !road) {
    return { future_price_eur: null, note: 'no price or no road nearby' };
  }
  let mult = baseMultiplier(road.road_type, dist);
  let nearAccess = false;
  if (land.lat != null && land.lon != null && hasAccessPointNear(land.lat, land.lon, 1000)) {
    mult += 0.5;
    nearAccess = true;
  }
  if (mult > 5) mult = 5;
  mult = Number(mult.toFixed(2));
  const note = `×${mult} — ${Math.round(dist)} m from ${roadLabel(road)} (${road.status || 'construction'})${
    nearAccess ? ', near access point' : ''
  }`;
  return { future_price_eur: Math.round(price * mult), note };
}

module.exports = { estimate };
