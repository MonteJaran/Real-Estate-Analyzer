// SQLite database — single source of truth for the schema.
// Uses Node's built-in node:sqlite (Node 22+), no native deps.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'booster.db');

let _db = null;

function nowIso() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_id TEXT UNIQUE,              -- 'way/123456' — stable identity across refreshes
  country TEXT NOT NULL,           -- ISO2: ME RS MK BA HR SI SK AL GR
  name TEXT,
  ref TEXT,                        -- road number, e.g. 'A1'
  road_type TEXT,                  -- motorway | trunk | primary | secondary | tertiary | unknown
  status TEXT NOT NULL,            -- construction | proposed
  length_m REAL,
  geometry TEXT NOT NULL,          -- JSON [[lat,lon],...] ordered along the way
  tags TEXT,                       -- JSON raw OSM tags
  source TEXT DEFAULT 'overpass',
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,  -- bbox for fast spatial prefilter
  first_seen TEXT,
  last_seen TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_roads_country ON roads(country);
CREATE INDEX IF NOT EXISTS idx_roads_bbox ON roads(min_lat, max_lat, min_lon, max_lon);

-- Interpolated positions along each road, one point every ~100 m (plus original vertices' start/end).
CREATE TABLE IF NOT EXISTS road_points (
  road_id INTEGER NOT NULL REFERENCES roads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  PRIMARY KEY (road_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_road_points_latlon ON road_points(lat, lon);

-- Candidate access/connection points: where a new road touches the existing network, plus endpoints.
CREATE TABLE IF NOT EXISTS road_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  road_id INTEGER NOT NULL REFERENCES roads(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  kind TEXT NOT NULL,              -- endpoint | junction_existing | tagged_junction
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_connections_road ON road_connections(road_id);

CREATE TABLE IF NOT EXISTS lands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT UNIQUE,                 -- listing URL; capture endpoint upserts on this
  source_site TEXT,                -- hostname, e.g. 'halooglasi.com', 'facebook.com', 'manual'
  title TEXT,
  country TEXT,                    -- ISO2
  lat REAL, lon REAL,
  location_text TEXT,              -- human-readable place if no coordinates
  size_m2 REAL,
  price_eur REAL,
  price_per_m2 REAL,
  contents TEXT DEFAULT 'land',    -- 'land' | 'land+house' | 'land+ruin' | free text
  description TEXT,
  images TEXT,                     -- JSON array of image URLs
  contacted INTEGER DEFAULT 0,     -- 0/1
  contact_status TEXT DEFAULT 'not_contacted', -- not_contacted|contacted|agreed_3pct|declined|sold|unreachable
  call_notes TEXT,
  owner_contact TEXT,              -- phone/name from the listing
  nearest_road_id INTEGER,         -- REFERENCES roads(id), nullable
  distance_to_road_m REAL,
  future_price_eur REAL,
  future_price_note TEXT,          -- human explanation of the multiplier used
  raw TEXT,                        -- JSON original captured payload
  captured_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lands_country ON lands(country);
CREATE INDEX IF NOT EXISTS idx_lands_latlon ON lands(lat, lon);

CREATE TABLE IF NOT EXISTS pois (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osm_id TEXT UNIQUE,              -- 'node/123' or 'way/123'
  name TEXT,
  kind TEXT,                       -- fuel|charging|hotel|restaurant|fast_food|supermarket|shop|car_dealer|industrial|other
  country TEXT,
  lat REAL, lon REAL,
  near_road_id INTEGER,            -- the stored road it was found near
  distance_m REAL,
  tags TEXT,                       -- JSON raw tags
  source TEXT DEFAULT 'overpass',  -- overpass | google
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pois_road ON pois(near_road_id);
CREATE INDEX IF NOT EXISTS idx_pois_country ON pois(country);

-- Road-related news/announcement links scraped from government & news sources.
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT,
  source_name TEXT,
  url TEXT UNIQUE,
  title TEXT,
  matched_keywords TEXT,           -- comma-separated keywords that matched
  found_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_announcements_country ON announcements(country);

-- Every outbound API/scrape call is logged here; the API status page reads it.
CREATE TABLE IF NOT EXISTS api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_name TEXT NOT NULL,          -- 'overpass' | 'google_places' | 'source:<country>:<name>' | ...
  endpoint TEXT,
  ts TEXT NOT NULL,
  ok INTEGER NOT NULL,             -- 0/1
  ms INTEGER,                      -- duration
  items INTEGER,                   -- how many records it produced
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_log_name_ts ON api_log(api_name, ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec(SCHEMA);
  return _db;
}

function logApi(apiName, endpoint, ok, ms, items, note) {
  getDb()
    .prepare('INSERT INTO api_log (api_name, endpoint, ts, ok, ms, items, note) VALUES (?,?,?,?,?,?,?)')
    .run(apiName, endpoint || null, nowIso(), ok ? 1 : 0, ms == null ? null : Math.round(ms), items == null ? null : items, note || null);
}

function getSetting(key, fallback) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (fallback === undefined ? null : fallback);
}

function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

module.exports = { getDb, nowIso, logApi, getSetting, setSetting, DB_PATH };
