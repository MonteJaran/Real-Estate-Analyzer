// Land database page: server-side filtered/sorted table, expandable detail rows
// with contact tracking (PATCH), buyer matching, manual add, CSV export.
'use strict';

renderNav('lands');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function eur(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }
function num(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }

let sort = 'captured_at';
let dir = 'desc';
let items = [];
let openId = null;

function queryString() {
  const p = new URLSearchParams();
  const val = (id) => document.getElementById(id).value.trim();
  if (val('f-country')) p.set('country', val('f-country'));
  if (val('f-contacted')) p.set('contacted', val('f-contacted'));
  if (val('f-minsize')) p.set('min_size', val('f-minsize'));
  if (val('f-maxsize')) p.set('max_size', val('f-maxsize'));
  if (val('f-minprice')) p.set('min_price', val('f-minprice'));
  if (val('f-maxprice')) p.set('max_price', val('f-maxprice'));
  if (val('f-maxdist')) p.set('max_distance', val('f-maxdist'));
  if (val('f-q')) p.set('q', val('f-q'));
  p.set('sort', sort);
  p.set('dir', dir);
  p.set('limit', '1000');
  return p.toString();
}

const CONTACT_BADGE = {
  not_contacted: 'badge-orange', contacted: 'badge-blue', agreed_3pct: 'badge-green',
  declined: 'badge-red', sold: 'badge-purple', unreachable: 'badge-red',
};

function rowHtml(l) {
  const cb = CONTACT_BADGE[l.contact_status] || 'badge-orange';
  const hasLink = l.url && !String(l.url).startsWith('manual:');
  return `<tr class="clickable" data-id="${l.id}" id="land-${l.id}">
    <td>${hasLink
      ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}"><b>${esc(l.title || '(no title)')}</b></a>`
      : `<b>${esc(l.title || '(no title)')}</b>`}
      <div class="muted small">${esc(l.location_text || '')}</div></td>
    <td>${esc(l.country || '')}</td>
    <td>${num(l.size_m2)}</td>
    <td>${eur(l.price_eur)}</td>
    <td>${l.price_per_m2 != null ? l.price_per_m2 : '–'}</td>
    <td>${num(l.distance_to_road_m)}</td>
    <td><b>${eur(l.future_price_eur)}</b></td>
    <td>${esc(l.contents || 'land')}</td>
    <td><span class="badge ${cb}">${esc(l.contact_status || 'not_contacted')}</span></td>
    <td class="muted small">${esc((l.captured_at || '').slice(0, 10))}</td>
  </tr>
  <tr class="detail-row" data-for="${l.id}" style="display:none"><td colspan="10"></td></tr>`;
}

function detailHtml(l) {
  const imgs = Array.isArray(l.images) ? l.images.slice(0, 8).map((u) =>
    `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt=""></a>`).join('') : '';
  const link = l.url && !String(l.url).startsWith('manual:')
    ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">open listing ↗</a>` : '<span class="muted">manual entry</span>';
  return `<div class="detail-panel">
    <div class="row">
      <div class="col">
        <dl class="kv">
          <dt>Listing</dt><dd>${link}</dd>
          <dt>Source</dt><dd>${esc(l.source_site || '–')}</dd>
          <dt>Position</dt><dd>${l.lat != null ? l.lat.toFixed(5) + ', ' + l.lon.toFixed(5) +
            ` · <a href="/map.html" title="open map">map</a>` : '<span class="muted">no coordinates — edit below</span>'}</dd>
          <dt>Nearest road</dt><dd>${l.nearest_road_id ? '#' + l.nearest_road_id + ' at ' + num(l.distance_to_road_m) + ' m' : '–'}</dd>
          <dt>Future price</dt><dd>${eur(l.future_price_eur)} € <span class="muted small">${esc(l.future_price_note || '')}</span></dd>
          <dt>Owner contact</dt><dd><input class="input" id="d-owner-${l.id}" value="${esc(l.owner_contact || '')}" style="width:100%"></dd>
        </dl>
        <div style="margin-top:8px">${imgs}</div>
        <p class="muted small" style="white-space:pre-wrap">${esc((l.description || '').slice(0, 1200))}</p>
      </div>
      <div class="col">
        <label class="field">Coordinates (lat, lon)
          <span style="display:flex;gap:6px">
            <input class="input" id="d-lat-${l.id}" type="number" step="any" value="${l.lat != null ? l.lat : ''}" placeholder="lat" style="width:50%">
            <input class="input" id="d-lon-${l.id}" type="number" step="any" value="${l.lon != null ? l.lon : ''}" placeholder="lon" style="width:50%">
          </span>
        </label>
        <label class="field" style="margin-top:6px">Contact status
          <select class="select" id="d-status-${l.id}">
            ${['not_contacted','contacted','agreed_3pct','declined','sold','unreachable']
              .map((s) => `<option value="${s}" ${l.contact_status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="field" style="margin-top:6px">
          <span><input type="checkbox" id="d-contacted-${l.id}" ${l.contacted ? 'checked' : ''}> contacted</span>
        </label>
        <label class="field" style="margin-top:6px">Call notes
          <textarea class="input" id="d-notes-${l.id}" rows="5" placeholder="what the owner said…">${esc(l.call_notes || '')}</textarea>
        </label>
        <div class="toolbar">
          <button class="btn btn-primary btn-sm" onclick="saveLand(${l.id})">Save</button>
          <button class="btn btn-sm" onclick="matchBuyers(${l.id})">Match buyers</button>
          <button class="btn btn-danger btn-sm right" onclick="deleteLand(${l.id})">Delete</button>
        </div>
        <div id="d-msg-${l.id}" class="muted small"></div>
        <div id="d-buyers-${l.id}"></div>
      </div>
    </div>
  </div>`;
}

async function load() {
  const res = await API.get('/api/lands?' + queryString());
  items = res.items;
  document.getElementById('count-line').textContent = `${res.items.length} of ${res.total} lands shown`;
  const tbody = document.querySelector('#lands-table tbody');
  tbody.innerHTML = items.map(rowHtml).join('') ||
    '<tr><td colspan="10" class="muted">Nothing captured yet — browse a listing and press the extension button (Alt+S), or add manually.</td></tr>';
  // header sort indicators
  document.querySelectorAll('#lands-table th.sortable').forEach((th) => {
    th.classList.toggle('sorted-asc', th.dataset.col === sort && dir === 'asc');
    th.classList.toggle('sorted-desc', th.dataset.col === sort && dir === 'desc');
  });
  if (openId) toggleDetail(openId, true);
}

function toggleDetail(id, forceOpen) {
  const dRow = document.querySelector(`tr.detail-row[data-for="${id}"]`);
  if (!dRow) return;
  const isOpen = dRow.style.display !== 'none';
  document.querySelectorAll('tr.detail-row').forEach((r) => { r.style.display = 'none'; });
  if (isOpen && !forceOpen) { openId = null; return; }
  const land = items.find((x) => x.id === id);
  if (!land) return;
  dRow.firstElementChild.innerHTML = detailHtml(land);
  dRow.style.display = '';
  openId = id;
}

window.saveLand = async function (id) {
  const g = (x) => document.getElementById(x + '-' + id);
  const body = {
    contacted: g('d-contacted').checked ? 1 : 0,
    contact_status: g('d-status').value,
    call_notes: g('d-notes').value,
    owner_contact: g('d-owner').value,
  };
  const lat = g('d-lat').value, lon = g('d-lon').value;
  if (lat !== '') body.lat = Number(lat);
  if (lon !== '') body.lon = Number(lon);
  try {
    await API.patch('/api/lands/' + id, body);
    g('d-msg').textContent = 'saved ✓';
    await load();
  } catch (e) { g('d-msg').textContent = 'save failed: ' + e.message; }
};

window.deleteLand = async function (id) {
  if (!confirm('Delete this land?')) return;
  try { await API.del('/api/lands/' + id); openId = null; await load(); }
  catch (e) { alert(e.message); }
};

window.matchBuyers = async function (id) {
  const box = document.getElementById('d-buyers-' + id);
  box.innerHTML = '<span class="spinner"></span>';
  try {
    const m = await API.get('/api/buyers/match/' + id);
    const cats = m.categories.map((c) =>
      `<span class="badge badge-green" title="${esc(c.requirements)}">${esc(c.label || c.category)}</span>`).join(' ');
    const cos = m.companies.map((c) =>
      `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
        <b>${esc(c.name)}</b> <span class="muted small">(${(c.countries||[]).join(', ')})</span><br>
        <span class="muted small">${esc(c.looking_for || '')}</span><br>
        <span class="small">${esc(c.contact_hint || '')}</span>
      </div>`).join('');
    box.innerHTML = `<h3>Matching buyer types</h3><div>${cats || '<span class="muted">none — check size/distance</span>'}</div>
      <h3>Companies to approach</h3>${cos || '<span class="muted">none for this country/category</span>'}`;
  } catch (e) { box.innerHTML = '<span class="muted">match failed: ' + esc(e.message) + '</span>'; }
};

function exportCsv() {
  const cols = ['id','title','country','location_text','lat','lon','size_m2','price_eur','price_per_m2',
    'distance_to_road_m','future_price_eur','contents','contacted','contact_status','call_notes','owner_contact','url','captured_at'];
  const escCsv = (v) => v == null ? '' : /[",\n;]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = [cols.join(';')].concat(items.map((l) => cols.map((c) => escCsv(l[c])).join(';')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lands.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- wiring ---
document.querySelector('#lands-table tbody').addEventListener('click', (ev) => {
  if (ev.target.closest('button, a, input, select, textarea')) return;
  const tr = ev.target.closest('tr.clickable');
  if (tr) toggleDetail(Number(tr.dataset.id));
});
document.querySelectorAll('#lands-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sort === col) dir = dir === 'asc' ? 'desc' : 'asc';
    else { sort = col; dir = 'desc'; }
    load();
  });
});
document.getElementById('btn-filter').addEventListener('click', load);
document.getElementById('btn-reset').addEventListener('click', () => {
  document.querySelectorAll('.filter-bar .input, .filter-bar .select').forEach((el) => { el.value = ''; });
  load();
});
document.getElementById('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
document.getElementById('btn-csv').addEventListener('click', exportCsv);
document.getElementById('btn-add').addEventListener('click', () => {
  document.getElementById('add-modal').style.display = '';
});
document.getElementById('a-save').addEventListener('click', async () => {
  const v = (x) => document.getElementById(x).value.trim();
  const body = {
    title: v('a-title') || null, country: v('a-country') || null,
    url: v('a-url') || undefined, location_text: v('a-location') || null,
    lat: v('a-lat') ? Number(v('a-lat')) : null, lon: v('a-lon') ? Number(v('a-lon')) : null,
    size_m2: v('a-size') ? Number(v('a-size')) : null, price_eur: v('a-price') ? Number(v('a-price')) : null,
    contents: v('a-contents'), owner_contact: v('a-owner') || null,
    description: v('a-desc') || null, source_site: 'manual',
  };
  try {
    await API.post('/api/lands', body);
    document.getElementById('add-modal').style.display = 'none';
    load();
  } catch (e) { document.getElementById('a-msg').textContent = e.message; }
});

fillCountries(document.getElementById('f-country'));
fillCountries(document.getElementById('a-country'));

// deep link: /lands.html#land-<id>
load().then(() => {
  const m = location.hash.match(/^#land-(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    toggleDetail(id, true);
    const el = document.getElementById('land-' + id);
    if (el) el.scrollIntoView({ block: 'center' });
  }
});
