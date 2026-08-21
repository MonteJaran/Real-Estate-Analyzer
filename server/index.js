// Real Estate Booster — express app entry point.
'use strict';

const path = require('path');
const express = require('express');
const scheduler = require('./services/scheduler');

const app = express();
const PORT = Number(process.env.PORT) || 3210;

app.use(express.json({ limit: '2mb' }));

// CORS for the Chrome extension on all /api/* routes.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Roads router is mounted at /api because it also serves GET /api/refresh/status.
app.use('/api', require('./routes/roads'));
app.use('/api/lands', require('./routes/lands'));
app.use('/api/pois', require('./routes/pois'));
app.use('/api/buyers', require('./routes/buyers'));
app.use('/api/status', require('./routes/status'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/billboards', require('./routes/billboards'));

// Country list for frontend dropdowns (iso2 + name + enabled), read fresh per request.
app.get('/api/countries', (req, res) => {
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'countries.json'), 'utf8'));
    res.json((data.countries || []).map((c) => ({
      iso2: c.iso2,
      name: c.name,
      enabled: !!c.enabled,
      portals: c.portals || [],
      land_notes: c.land_notes || '',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Corridor watchlist from research (projects.json), read fresh per request.
app.get('/api/projects', (req, res) => {
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'projects.json'), 'utf8'));
    let projects = data.projects || [];
    if (req.query.country) {
      const c = String(req.query.country).toUpperCase();
      projects = projects.filter((p) => p.country === c);
    }
    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Unknown API route → JSON 404 (instead of falling through to static/html 404).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Static frontend; '/' serves public/index.html.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Final error handler: body-parser errors get their status (e.g. 400), everything else 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  res.status(err.statusCode || err.status || 500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, () => {
  console.log(`Real Estate Booster running at http://localhost:${PORT}`);
  scheduler.init();
});
