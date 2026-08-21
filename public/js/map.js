// Leaflet map page: roads (by status), land markers with hover popups,
// connection points, POIs, per-road actions (POIs near road, 5 km zone).
'use strict';

renderNav('map');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function eur(n){ return n == null ? '–' : Math.round(n).toLocaleString('en') + ' €'; }
function num(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }

const map = L.map('map').setView([43.5, 20.0], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const roadsLayer = L.layerGroup().addTo(map);
const landsLayer = L.layerGroup().addTo(map);
const connLayer = L.layerGroup();
const poisLayer = L.layerGroup();
const zoneLayer = L.layerGroup().addTo(map);

let roadsGeo = null; // FeatureCollection cache
let roadIds = new Set(); // ids of currently displayed roads (for the near-road land filter)
let lastFit = '';
let moveTimer = null;

const msg = (t) => { document.getElementById('map-msg').textContent = t || ''; };

const ROAD_STYLE = {
  construction: { color: '#ff9a2e', weight: 4, opacity: 0.9 },
  proposed: { color: '#f85149', weight: 3, opacity: 0.8, dashArray: '8 6' },
};

function roadPopup(p) {
  const src = p.osm_id
    ? `<a href="https://www.openstreetmap.org/${esc(p.osm_id)}" target="_blank" rel="noopener">source: OpenStreetMap ${esc(p.osm_id)} ↗</a>`
    : `source: ${esc(p.source || 'unknown')}`;
  return `<b>${esc(p.name || p.ref || 'unnamed road')}</b><br>
    <span class="muted">${esc(p.road_type)} · ${esc(p.status)} · ${num(p.length_m)} m · ${esc(p.country)}</span><br>
    connections: ${p.connections_count}<br>
    ${src} <span class="muted">· seen ${esc((p.last_seen || '').slice(0, 10))}</span><br>
    <div style="margin-top:6px;display:flex;gap:6px">
      <button class="btn btn-sm" onclick="loadRoadPois(${p.id})">POIs near road</button>
      <button class="btn btn-sm" onclick="showZone(${p.id})">5 km zone</button>
      <button class="btn btn-sm" onclick="showConnections(${p.id})">Connections</button>
    </div>`;
}

function landPopup(l) {
  const badge = l.contacted
    ? '<span class="badge badge-green">contacted</span>'
    : '<span class="badge badge-orange">not contacted</span>';
  return `<b>${esc(l.title || 'land')}</b> ${badge}<br>
    <span class="muted">${esc(l.location_text || '')} ${esc(l.country || '')}</span><br>
    size: ${num(l.size_m2)} m² · price: ${eur(l.price_eur)} (${l.price_per_m2 != null ? l.price_per_m2 + ' €/m²' : '–'})<br>
    distance to new road: ${num(l.distance_to_road_m)} m<br>
    est. future price: <b>${eur(l.future_price_eur)}</b><br>
    <span class="muted small">${esc(l.future_price_note || '')}</span><br>
    <a href="/lands.html#land-${l.id}">open in Land database</a>
    ${l.url && !String(l.url).startsWith('manual:') ? ` · <a href="${esc(l.url)}" target="_blank" rel="noopener">listing</a>` : ''}`;
}

async function loadRoads() {
  const c = document.getElementById('sel-country').value;
  const s = document.getElementById('sel-status').value;
  const qs = [];
  if (c) qs.push('country=' + c);
  else {
    // No country selected: with all of Europe tracked, "everything" is too much
    // for one fetch — load only the current viewport (needs some zoom).
    if (map.getZoom() < 6) {
      roadsLayer.clearLayers();
      roadsGeo = null;
      roadIds = new Set();
      msg('pick a country or zoom in to load roads');
      return;
    }
    const b = map.getBounds();
    qs.push(`bbox=${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`);
  }
  if (s) qs.push('status=' + s);
  msg('loading roads…');
  try {
    roadsGeo = await API.get('/api/roads' + (qs.length ? '?' + qs.join('&') : ''));
    roadIds = new Set(roadsGeo.features.map((f) => f.properties.id));
    roadsLayer.clearLayers();
    const layer = L.geoJSON(roadsGeo, {
      style: (f) => ROAD_STYLE[f.properties.status] || ROAD_STYLE.construction,
      onEachFeature: (f, lyr) => {
        lyr.bindPopup(roadPopup(f.properties), { maxWidth: 320 });
        lyr.on('mouseover', () => lyr.setStyle({ weight: 7 }));
        lyr.on('mouseout', () => lyr.setStyle(ROAD_STYLE[f.properties.status] || ROAD_STYLE.construction));
      },
    });
    roadsLayer.addLayer(layer);
    msg(roadsGeo.features.length + ' road segments');
    // Fit bounds when the country selection changes and we have geometry.
    const fitKey = c + '|' + s;
    if (roadsGeo.features.length && fitKey !== lastFit && c) {
      map.fitBounds(layer.getBounds().pad(0.15));
    }
    lastFit = fitKey;
  } catch (e) {
    msg('roads failed: ' + e.message);
  }
}

async function loadLands() {
  landsLayer.clearLayers();
  if (!document.getElementById('chk-lands').checked) return;
  const c = document.getElementById('sel-country').value;
  const nearOnly = document.getElementById('chk-near').checked;
  try {
    const res = await API.get('/api/lands?limit=2000' + (c ? '&country=' + c : '') + (nearOnly ? '&max_distance=5000' : ''));
    for (const l of res.items) {
      if (l.lat == null || l.lon == null) continue;
      // With the near filter on, also respect the current road status/viewport scope
      // when roads are loaded (roadIds empty = keep everything the server returned).
      if (nearOnly && roadIds.size && l.nearest_road_id != null && !roadIds.has(l.nearest_road_id)) continue;
      const m = L.circleMarker([l.lat, l.lon], {
        radius: 7, color: '#2ea043', fillColor: '#3fb950', fillOpacity: 0.85, weight: 1,
      });
      m.bindPopup(landPopup(l), { maxWidth: 320 });
      m.on('mouseover', function () { this.openPopup(); this.setRadius(10); });
      m.on('mouseout', function () { this.setRadius(7); });
      landsLayer.addLayer(m);
    }
  } catch (e) {
    msg('lands failed: ' + e.message);
  }
}

async function loadConnectionsLayer() {
  connLayer.clearLayers();
  if (!document.getElementById('chk-conn').checked) { map.removeLayer(connLayer); return; }
  map.addLayer(connLayer);
  if (!roadsGeo) return;
  // Load connection points road-by-road (only roads currently in view scope).
  msg('loading connections…');
  let count = 0;
  for (const f of roadsGeo.features) {
    if (!f.properties.connections_count) continue;
    try {
      const d = await API.get('/api/roads/' + f.properties.id);
      for (const cn of d.connections) {
        const m = L.circleMarker([cn.lat, cn.lon], {
          radius: 5, color: '#8957e5', fillColor: '#bc8cff', fillOpacity: 0.9, weight: 1,
        });
        m.bindPopup(`<b>${esc(cn.kind)}</b><br>${esc(cn.note || '')}<br>
          <span class="muted small">${esc(f.properties.name || f.properties.ref || '')}</span>`);
        connLayer.addLayer(m);
        count++;
      }
    } catch (e) { /* keep going */ }
  }
  msg(count + ' connection points');
}

const POI_COLORS = { fuel: '#f0883e', charging: '#58a6ff', hotel: '#d2a8ff', restaurant: '#ffa198',
  fast_food: '#ffa198', supermarket: '#7ee787', shop: '#7ee787', car_dealer: '#79c0ff', industrial: '#8b98a5', other: '#8b98a5' };

async function loadPois() {
  poisLayer.clearLayers();
  if (!document.getElementById('chk-pois').checked) { map.removeLayer(poisLayer); return; }
  map.addLayer(poisLayer);
  const c = document.getElementById('sel-country').value;
  try {
    const rows = await API.get('/api/pois' + (c ? '?country=' + c : ''));
    renderPois(rows);
    msg(rows.length + ' POIs' + (rows.length === 0 ? ' — run "Refresh POIs" on the API status page first' : ''));
  } catch (e) {
    msg('pois failed: ' + e.message);
  }
}

function renderPois(rows) {
  for (const p of rows) {
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 4, color: POI_COLORS[p.kind] || '#8b98a5', fillColor: POI_COLORS[p.kind] || '#8b98a5',
      fillOpacity: 0.8, weight: 1,
    });
    m.bindPopup(`<b>${esc(p.name || p.kind)}</b><br><span class="muted">${esc(p.kind)} · ${num(p.distance_m)} m from road</span>`);
    poisLayer.addLayer(m);
  }
}

// --- per-road actions used from popups (global functions) ---
window.loadRoadPois = async function (roadId) {
  try {
    const rows = await API.get('/api/pois?road_id=' + roadId);
    if (!rows.length) { alert('No stored POIs for this road yet — run "Refresh POIs" for the country on the API status page.'); return; }
    map.addLayer(poisLayer);
    document.getElementById('chk-pois').checked = true;
    renderPois(rows);
    msg(rows.length + ' POIs near road #' + roadId);
  } catch (e) { alert(e.message); }
};

window.showZone = async function (roadId) {
  try {
    const d = await API.get('/api/roads/' + roadId);
    zoneLayer.clearLayers();
    // 5 km influence zone approximated with translucent circles along the road points.
    const pts = d.points.filter((_, i) => i % 10 === 0); // every ~1 km
    for (const p of pts) {
      zoneLayer.addLayer(L.circle([p.lat, p.lon], {
        radius: 5000, stroke: false, fillColor: '#4da3ff', fillOpacity: 0.06, interactive: false,
      }));
    }
    msg('5 km zone shown for road #' + roadId + ' (click map to clear)');
    map.once('click', () => zoneLayer.clearLayers());
  } catch (e) { alert(e.message); }
};

window.showConnections = async function (roadId) {
  try {
    const d = await API.get('/api/roads/' + roadId);
    map.addLayer(connLayer);
    document.getElementById('chk-conn').checked = true;
    for (const cn of d.connections) {
      const m = L.circleMarker([cn.lat, cn.lon], {
        radius: 6, color: '#8957e5', fillColor: '#bc8cff', fillOpacity: 0.95, weight: 1,
      });
      m.bindPopup(`<b>${esc(cn.kind)}</b><br>${esc(cn.note || '')}`);
      connLayer.addLayer(m);
    }
    msg(d.connections.length + ' connection points for road #' + roadId);
  } catch (e) { alert(e.message); }
};

// --- wiring ---
document.getElementById('sel-country').addEventListener('change', () => { loadRoads().then(loadLands); loadPois(); });
document.getElementById('sel-status').addEventListener('change', () => loadRoads().then(loadLands));
document.getElementById('chk-lands').addEventListener('change', loadLands);
document.getElementById('chk-near').addEventListener('change', loadLands);
document.getElementById('chk-conn').addEventListener('change', loadConnectionsLayer);
document.getElementById('chk-pois').addEventListener('change', loadPois);
// viewport-based road loading when no country is selected (debounced)
map.on('moveend', () => {
  if (document.getElementById('sel-country').value) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => loadRoads().then(loadLands), 600);
});

fillCountries(document.getElementById('sel-country'));
loadRoads().then(loadLands);
