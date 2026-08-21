// Billboard suitability engine. Legal reality (researched, Serbian Zakon o putevima;
// ME/MK follow the same tradition): billboards are BANNED along motorway mainlines
// (60 m protective zone, rest areas excepted) but allowed ~7 m from state-road and
// ~5 m from municipal-road edges WITH road-manager approval. So the plays are
// feeder roads near new interchanges and non-motorway new roads with direct frontage.
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const geo = require('./geo');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'billboards.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Nearest road_connections point to a location (bbox prefilter), or null.
function nearestConnectionM(lat, lon, maxM) {
  const dLat = maxM / 111320;
  const dLon = maxM / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const rows = db.getDb()
    .prepare('SELECT lat, lon FROM road_connections WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);
  let best = null;
  for (const r of rows) {
    const d = geo.haversineM(lat, lon, r.lat, r.lon);
    if (best == null || d < best) best = d;
  }
  return best == null ? null : Math.round(best);
}

function rateFor(cfg, cls) {
  const r = cfg.economics.monthly_rent_per_face_eur[cls];
  return (r.low + r.high) / 2;
}

// One land → suitability + economics, or null when out of scope (no coords/road).
function evaluate(cfg, land, road) {
  const maxDist = cfg.scoring.max_distance_to_road_m;
  if (land.lat == null || land.lon == null || !road || land.distance_to_road_m == null) return null;
  if (land.distance_to_road_m > maxDist) return null;

  const connDist = nearestConnectionM(land.lat, land.lon, 3000);
  const isMotorway = road.road_type === 'motorway';
  const nearFeeder = connDist != null && connDist <= 1000;

  let suitable = true;
  let placement;
  let rateClass;
  if (isMotorway && !nearFeeder) {
    // Mainline frontage only — legally worthless for billboards.
    suitable = false;
    placement = 'NOT SUITABLE: motorway mainline — billboards banned in the 60 m protective zone and no interchange nearby';
    rateClass = null;
  } else if (isMotorway) {
    placement = `Via interchange feeder roads (~${connDist} m to access point) — place on the connecting state/local road, NOT the motorway itself`;
    rateClass = 'interchange_feeder_or_town_entry';
  } else if (nearFeeder) {
    placement = `Direct frontage possible (min setback + road-manager approval); ${connDist} m from an access point of the new road`;
    rateClass = 'interchange_feeder_or_town_entry';
  } else if (['trunk', 'primary', 'secondary', 'unknown'].includes(road.road_type)) {
    placement = 'Direct frontage on the new road (min setback + road-manager approval)';
    rateClass = 'state_road_transit';
  } else {
    placement = 'Minor road frontage — low traffic';
    rateClass = 'rural_low_traffic';
  }

  let score = 0;
  let est = null;
  if (suitable) {
    const base = rateClass === 'interchange_feeder_or_town_entry' ? 80
      : rateClass === 'state_road_transit' ? 60 : 35;
    score = base - (land.distance_to_road_m / maxDist) * 25;
    if (land.size_m2 != null && land.size_m2 >= cfg.scoring.min_land_size_m2) score += 5;
    if (land.size_m2 == null) score -= 5;
    if (isMotorway) score -= 10; // extra step: the billboard goes on the feeder, not the frontage
    if (road.status === 'proposed') score *= 0.6; // traffic much further out
    score = Math.max(0, Math.min(100, Math.round(score)));

    const faces = 2;
    const occupancy = cfg.economics.occupancy;
    const setup = cfg.economics.setup_cost_eur.standard_12m2_double_face;
    const perFace = rateFor(cfg, rateClass);
    const grossMonthly = perFace * faces * occupancy;
    const annualNet = Math.round(grossMonthly * 12 - 500); // ~€500/yr permits+maintenance
    const landPrice = land.price_eur != null ? land.price_eur : null;
    const totalInvest = landPrice != null ? landPrice + setup : null;
    est = {
      board: 'standard 12 m² double-faced',
      faces,
      occupancy,
      monthly_rent_per_face_eur: Math.round(perFace),
      gross_monthly_eur: Math.round(grossMonthly),
      annual_net_eur: annualNet,
      setup_cost_eur: setup,
      payback_setup_only_years: annualNet > 0 ? Math.round((setup / annualNet) * 10) / 10 : null,
      total_investment_eur: totalInvest,
      payback_with_land_years: totalInvest != null && annualNet > 0
        ? Math.round((totalInvest / annualNet) * 10) / 10 : null,
      lease_out_alternative_eur_month: cfg.economics.land_lease_alternative_eur_month,
    };
  }

  const legal = cfg.legal[land.country] || null;
  return {
    land_id: land.id,
    title: land.title,
    url: land.url,
    country: land.country,
    lat: land.lat,
    lon: land.lon,
    size_m2: land.size_m2,
    price_eur: land.price_eur,
    distance_to_road_m: land.distance_to_road_m,
    connection_distance_m: connDist,
    road: {
      id: road.id, name: road.name, ref: road.ref,
      road_type: road.road_type, status: road.status,
    },
    suitable,
    score,
    rate_class: rateClass,
    placement,
    est,
    legal_note: legal ? (road.road_type === 'motorway' ? legal.motorway_mainline : legal.state_road) : null,
  };
}

// All captured lands ranked by billboard suitability. includeUnsuitable=true also
// returns the legally-dead entries so the UI can explain why.
function suggest(country, includeUnsuitable) {
  const cfg = loadConfig();
  const d = db.getDb();
  const where = ['lat IS NOT NULL', 'lon IS NOT NULL', 'nearest_road_id IS NOT NULL'];
  const params = [];
  if (country) { where.push('country = ?'); params.push(country); }
  const lands = d.prepare(`SELECT * FROM lands WHERE ${where.join(' AND ')}`).all(...params);
  const roadStmt = d.prepare('SELECT * FROM roads WHERE id = ?');
  const out = [];
  let considered = 0;
  for (const land of lands) {
    considered++;
    const road = roadStmt.get(land.nearest_road_id);
    const r = evaluate(cfg, land, road);
    if (!r) continue;
    if (!r.suitable && !includeUnsuitable) continue;
    out.push(r);
  }
  out.sort((a, b) => b.score - a.score);
  return { considered, suggestions: out };
}

module.exports = { loadConfig, suggest };
