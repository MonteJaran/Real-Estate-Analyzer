// Geo math helpers. Pure math except nearestRoad(), which queries the roads table.
// Coordinates are [lat, lon] everywhere (Leaflet order).
'use strict';

const db = require('../db');

const M_PER_DEG_LAT = 111320; // meters per degree of latitude (close enough everywhere)

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// coords: [[lat,lon],...]
function lineLengthM(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversineM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  }
  return total;
}

// Points every stepM along the polyline, always including the first and last vertex.
// Returns [{lat, lon}].
function interpolateEveryM(coords, stepM) {
  if (!Array.isArray(coords) || coords.length === 0) return [];
  const pts = [{ lat: coords[0][0], lon: coords[0][1] }];
  if (coords.length === 1 || !(stepM > 0)) {
    if (coords.length > 1) pts.push({ lat: coords[coords.length - 1][0], lon: coords[coords.length - 1][1] });
    return pts;
  }
  let sinceLast = 0; // meters walked since the last emitted point
  for (let i = 0; i < coords.length - 1; i++) {
    const [lat1, lon1] = coords[i];
    const [lat2, lon2] = coords[i + 1];
    const segLen = haversineM(lat1, lon1, lat2, lon2);
    if (segLen <= 0) continue;
    let travelled = 0;
    while (sinceLast + (segLen - travelled) >= stepM) {
      travelled += stepM - sinceLast;
      const t = travelled / segLen; // linear interpolation is fine at these scales
      pts.push({ lat: lat1 + (lat2 - lat1) * t, lon: lon1 + (lon2 - lon1) * t });
      sinceLast = 0;
    }
    sinceLast += segLen - travelled;
  }
  const last = coords[coords.length - 1];
  const lastPt = pts[pts.length - 1];
  if (haversineM(lastPt.lat, lastPt.lon, last[0], last[1]) > 1) {
    pts.push({ lat: last[0], lon: last[1] });
  }
  return pts;
}

// Min distance in meters from a point to a polyline, using segment projection on a
// local equirectangular plane centered at the point (accurate enough for <100 km).
function pointToLineDistanceM(lat, lon, coords) {
  if (!Array.isArray(coords) || coords.length === 0) return Infinity;
  const cosLat = Math.cos(toRad(lat));
  const toXY = (la, lo) => [(lo - lon) * M_PER_DEG_LAT * cosLat, (la - lat) * M_PER_DEG_LAT];
  if (coords.length === 1) {
    const [x, y] = toXY(coords[0][0], coords[0][1]);
    return Math.sqrt(x * x + y * y);
  }
  let min = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = toXY(coords[i][0], coords[i][1]);
    const [x2, y2] = toXY(coords[i + 1][0], coords[i + 1][1]);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    // project origin (the query point) onto the segment, clamped to [0,1]
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lenSq));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const d = Math.sqrt(px * px + py * py);
    if (d < min) min = d;
  }
  return min;
}

// Nearest stored road within maxM meters. Bbox prefilter via roads min/max columns,
// then exact polyline distance on the parsed geometry JSON.
// Returns {road_id, distance_m, road} or null.
function nearestRoad(lat, lon, maxM = 30000) {
  const dLat = maxM / M_PER_DEG_LAT;
  const dLon = maxM / (M_PER_DEG_LAT * Math.max(0.1, Math.cos(toRad(lat))));
  const rows = db
    .getDb()
    .prepare(
      `SELECT * FROM roads
       WHERE min_lat IS NOT NULL
         AND min_lat <= ? AND max_lat >= ?
         AND min_lon <= ? AND max_lon >= ?`
    )
    .all(lat + dLat, lat - dLat, lon + dLon, lon - dLon);
  let bestD = Infinity;
  let bestRow = null;
  for (const row of rows) {
    let coords;
    try {
      coords = JSON.parse(row.geometry);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const d = pointToLineDistanceM(lat, lon, coords);
    if (d <= maxM && d < bestD) {
      bestD = d;
      bestRow = row;
    }
  }
  if (!bestRow) return null;
  return { road_id: bestRow.id, distance_m: Math.round(bestD), road: bestRow };
}

// Coarse country bounding boxes — good enough for tagging captured land.
const COUNTRY_BBOXES = [
  { iso2: 'ME', minLat: 41.85, maxLat: 43.57, minLon: 18.43, maxLon: 20.36 },
  { iso2: 'RS', minLat: 42.23, maxLat: 46.19, minLon: 18.82, maxLon: 23.01 },
  { iso2: 'MK', minLat: 40.85, maxLat: 42.37, minLon: 20.45, maxLon: 23.04 },
  { iso2: 'BA', minLat: 42.55, maxLat: 45.28, minLon: 15.72, maxLon: 19.62 },
  { iso2: 'HR', minLat: 42.38, maxLat: 46.55, minLon: 13.49, maxLon: 19.45 },
  { iso2: 'SI', minLat: 45.42, maxLat: 46.88, minLon: 13.37, maxLon: 16.61 },
  { iso2: 'SK', minLat: 47.73, maxLat: 49.62, minLon: 16.83, maxLon: 22.57 },
  { iso2: 'AL', minLat: 39.64, maxLat: 42.66, minLon: 19.26, maxLon: 21.06 },
  { iso2: 'GR', minLat: 34.80, maxLat: 41.75, minLon: 19.37, maxLon: 29.65 },
];

// iso2 or null. When bboxes overlap, prefer the smaller country (smaller bbox area).
function countryOf(lat, lon) {
  const hits = COUNTRY_BBOXES.filter(
    (b) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon
  );
  if (!hits.length) return null;
  hits.sort(
    (a, b) => (a.maxLat - a.minLat) * (a.maxLon - a.minLon) - (b.maxLat - b.minLat) * (b.maxLon - b.minLon)
  );
  return hits[0].iso2;
}

// Bounding box of a coordinate list, optionally padded by padM meters.
function bboxOf(coords, padM = 0) {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const c of coords || []) {
    if (c[0] < minLat) minLat = c[0];
    if (c[0] > maxLat) maxLat = c[0];
    if (c[1] < minLon) minLon = c[1];
    if (c[1] > maxLon) maxLon = c[1];
  }
  if (!isFinite(minLat)) return { minLat: null, minLon: null, maxLat: null, maxLon: null };
  if (padM > 0) {
    const dLat = padM / M_PER_DEG_LAT;
    const midLat = (minLat + maxLat) / 2;
    const dLon = padM / (M_PER_DEG_LAT * Math.max(0.1, Math.cos(toRad(midLat))));
    minLat -= dLat;
    maxLat += dLat;
    minLon -= dLon;
    maxLon += dLon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

module.exports = {
  haversineM,
  lineLengthM,
  interpolateEveryM,
  pointToLineDistanceM,
  nearestRoad,
  countryOf,
  bboxOf,
};
