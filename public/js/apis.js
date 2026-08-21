// API status page: scheduler state + live job log, API usage cards, source table,
// refresh actions, recent api_log, Google settings.
'use strict';

renderNav('apis');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function ts(t){ return t ? String(t).replace('T', ' ').slice(0, 19) : 'never'; }
function okBadge(ok){ return ok == null ? '–' : ok ? '<span class="badge badge-green">ok</span>' : '<span class="badge badge-red">fail</span>'; }

let pollTimer = null;

async function loadStatus() {
  const st = await API.get('/api/status');
  const sch = st.scheduler || {};

  const running = sch.running;
  document.getElementById('s-running').innerHTML = running
    ? `<span class="spinner"></span> ${esc(running.type)} ${esc(running.country || 'all')} (since ${ts(running.startedAt)})`
    : 'idle';
  document.getElementById('s-next').textContent = ts(sch.nextCronRun) + ' (every 2 days at 06:00 while the app runs)';
  document.getElementById('s-last-roads').textContent = ts(sch.lastRun && sch.lastRun.roads);
  document.getElementById('s-last-pois').textContent = ts(sch.lastRun && sch.lastRun.pois);
  document.getElementById('s-last-ann').textContent = ts(sch.lastRun && sch.lastRun.announcements);
  const counts = Object.entries(sch.roadCounts || {})
    .map(([c, v]) => `${c}: ${v.total} (${v.construction || 0} constr., ${v.proposed || 0} prop.)`).join(' · ');
  document.getElementById('s-counts').textContent = counts || 'none yet';

  const logLines = (running && running.log && running.log.length ? running.log
    : (sch.lastJob && sch.lastJob.log) || []);
  document.getElementById('s-log').textContent = logLines.length ? logLines.join('\n') : '–';

  document.getElementById('api-cards').innerHTML = (st.apis || []).map((a) => `
    <div style="padding:8px 0;border-bottom:1px solid var(--border)">
      <b>${esc(a.api_name)}</b> ${okBadge(a.last_ok)}
      <div class="muted small">last call: ${ts(a.last_call_ts)} · today: ${a.calls_today} · month: ${a.calls_month} calls / ${a.items_month} items
      ${a.ok_rate_month != null ? ' · ok rate ' + Math.round(a.ok_rate_month * 100) + '%' : ''}</div>
      ${a.limit_note ? `<div class="small badge badge-orange" style="margin-top:3px">${esc(a.limit_note)}</div>` : ''}
    </div>`).join('');

  document.querySelector('#src-table tbody').innerHTML = (st.sources || []).map((s) => `<tr>
    <td>${esc(s.country)}</td>
    <td><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></td>
    <td class="small">${esc(s.kind || '')}</td>
    <td class="small">${s.scrape_method === 'needs_js'
      ? '<span class="badge badge-red" title="JS-rendered or bot-blocked — open manually in the browser">manual</span>'
      : '<span class="badge badge-green">auto</span>'}</td>
    <td class="muted small">${ts(s.last_call_ts)}</td>
    <td>${okBadge(s.last_ok)}</td>
    <td>${s.last_items != null ? s.last_items : '–'}</td>
    <td>${s.calls_month}</td>
  </tr>`).join('');

  if (running) { clearTimeout(pollTimer); pollTimer = setTimeout(loadStatus, 3000); }
}

async function loadLog() {
  const f = document.getElementById('log-filter').value.trim();
  const rows = await API.get('/api/status/log?limit=100' + (f ? '&api_name=' + encodeURIComponent(f) : ''));
  document.querySelector('#log-table tbody').innerHTML = rows.map((r) => `<tr>
    <td class="muted small">${ts(r.ts)}</td><td>${esc(r.api_name)}</td>
    <td class="small">${esc((r.endpoint || '').slice(0, 80))}</td>
    <td>${okBadge(r.ok)}</td><td>${r.ms != null ? r.ms : ''}</td><td>${r.items != null ? r.items : ''}</td>
    <td class="muted small">${esc((r.note || '').slice(0, 120))}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="muted">no calls logged yet</td></tr>';
}

async function action(path, body, label) {
  const msg = document.getElementById('act-msg');
  msg.textContent = label + '…';
  try {
    await API.post(path, body);
    msg.textContent = label + ' started — watch the job log.';
  } catch (e) {
    msg.textContent = e.status === 409 ? 'A job is already running — wait for it to finish.' : label + ' failed: ' + e.message;
  }
  loadStatus();
}

document.getElementById('act-roads').addEventListener('click', () => {
  const c = document.getElementById('act-country').value;
  action('/api/roads/refresh', c ? { country: c } : {}, 'Road refresh');
});
document.getElementById('act-ann').addEventListener('click', () => {
  const c = document.getElementById('act-country').value;
  action('/api/announcements/refresh', c ? { country: c } : {}, 'Announcements refresh');
});
document.getElementById('act-pois').addEventListener('click', () => {
  const c = document.getElementById('act-country').value;
  if (!c) { document.getElementById('act-msg').textContent = 'POI refresh needs a specific country — pick one.'; return; }
  action('/api/pois/refresh', { country: c }, 'POI refresh');
});
document.getElementById('act-recompute').addEventListener('click', async () => {
  const msg = document.getElementById('act-msg');
  try {
    const r = await API.post('/api/lands/recompute', {});
    msg.textContent = `Recomputed ${r.updated} lands.`;
  } catch (e) { msg.textContent = 'recompute failed: ' + e.message; }
});
document.getElementById('log-reload').addEventListener('click', loadLog);

document.getElementById('set-save').addEventListener('click', async () => {
  const body = {};
  const key = document.getElementById('set-gkey').value.trim();
  const cap = document.getElementById('set-gcap').value.trim();
  if (key) body.google_api_key = key;
  if (cap) body.google_monthly_cap = cap;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'failed');
    document.getElementById('set-msg').textContent = 'saved ✓';
    loadSettings();
  } catch (e) { document.getElementById('set-msg').textContent = 'save failed: ' + e.message; }
});

async function loadSettings() {
  try {
    const s = await API.get('/api/settings');
    if (s.google_api_key) document.getElementById('set-gkey').placeholder = 'saved: ' + s.google_api_key;
    if (s.google_monthly_cap) document.getElementById('set-gcap').value = s.google_monthly_cap;
  } catch (e) { /* first run: no settings yet */ }
}

fillCountries(document.getElementById('act-country'));
loadStatus();
loadLog();
loadSettings();
