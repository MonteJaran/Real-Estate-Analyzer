// Billboards page: legal rules, economics, and ranked land suggestions with
// revenue/payback calculations (server-side engine at /api/billboards/suggest).
'use strict';

renderNav('billboards');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function num(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }

async function loadConfig() {
  const cfg = await API.get('/api/billboards');
  document.getElementById('bb-strategy').textContent = cfg.strategy;

  document.getElementById('bb-rules').innerHTML = Object.entries(cfg.legal).map(([iso, l]) => `
    <div class="card">
      <h3 style="margin-top:0">${esc(iso)} — legal rules</h3>
      <p class="small"><b>Motorway:</b> ${esc(l.motorway_mainline)}</p>
      <p class="small"><b>State road:</b> ${esc(l.state_road)}</p>
      <p class="small"><b>Municipal road:</b> ${esc(l.municipal_road)}</p>
      ${(l.sources || []).map((s) => `<a class="small" href="${esc(s)}" target="_blank" rel="noopener">source ↗</a>`).join(' · ')}
    </div>`).join('');

  const e = cfg.economics;
  const rentRows = Object.entries(e.monthly_rent_per_face_eur).map(([k, v]) =>
    `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>€${v.low}–${v.high}</td></tr>`).join('');
  const setupRows = Object.entries(e.setup_cost_eur).filter(([k]) => k !== 'note').map(([k, v]) =>
    `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>€${num(v)}</td></tr>`).join('');
  document.getElementById('bb-econ').innerHTML = `
    <div class="card"><h3 style="margin-top:0">Monthly rent per face</h3>
      <table class="table">${rentRows}</table>
      <p class="muted small">Occupancy assumed: ${Math.round(e.occupancy * 100)}%</p></div>
    <div class="card"><h3 style="margin-top:0">Setup costs</h3>
      <table class="table">${setupRows}</table>
      <p class="muted small">${esc(e.setup_cost_eur.note)}</p></div>
    <div class="card"><h3 style="margin-top:0">Zero-effort alternative</h3>
      <p class="small">Lease the spot to an outdoor-advertising company instead of operating it:
      <b>€${e.land_lease_alternative_eur_month.low}–${e.land_lease_alternative_eur_month.high}/month</b> passive.</p>
      <p class="muted small">${esc(e.land_lease_alternative_eur_month.note)}</p></div>`;

  document.getElementById('bb-legal-note').textContent =
    'Numbers are market estimates for planning, not quotes. Every billboard needs road-manager approval ' +
    '(Putevi Srbije / Uprava za saobraćaj / JPDP or the municipality) plus a municipal permit — verify locally before buying land.';
}

async function loadSuggestions() {
  const c = document.getElementById('bb-country').value;
  const all = document.getElementById('bb-all').checked;
  const qs = new URLSearchParams();
  if (c) qs.set('country', c);
  if (all) qs.set('all', '1');
  const res = await API.get('/api/billboards/suggest?' + qs.toString());
  document.getElementById('bb-count').textContent =
    `${res.suggestions.length} suggestions from ${res.considered} lands with coordinates near roads`;
  document.querySelector('#bb-table tbody').innerHTML = res.suggestions.map((s) => {
    const e = s.est;
    return `<tr ${s.suitable ? '' : 'style="opacity:.5"'}>
      <td style="min-width:90px">
        <div class="score-bar"><div style="width:${s.score}%"></div></div>
        <span class="small">${s.score}/100</span></td>
      <td><a href="/lands.html#land-${s.land_id}"><b>${esc(s.title || 'land #' + s.land_id)}</b></a>
        <div class="muted small">${esc(s.country || '')} · ${num(s.size_m2)} m² · ${num(s.price_eur)} €</div></td>
      <td class="small">${esc(s.road.ref || s.road.name || '#' + s.road.id)}
        <div class="muted">${esc(s.road.road_type)} · ${esc(s.road.status)}</div></td>
      <td>${num(s.distance_to_road_m)}</td>
      <td>${num(s.connection_distance_m)}</td>
      <td class="small">${esc(s.placement)}<div class="muted small">${esc(s.legal_note || '')}</div></td>
      <td>${e ? '<b>' + num(e.annual_net_eur / 12) + '</b><div class="muted small">€' + e.monthly_rent_per_face_eur + '/face ×' + e.faces + '</div>' : '–'}</td>
      <td>${e ? num(e.setup_cost_eur) : '–'}</td>
      <td class="small">${e && e.payback_setup_only_years != null ? e.payback_setup_only_years + ' yr (board only)' : '–'}
        ${e && e.payback_with_land_years != null ? '<div class="muted">' + e.payback_with_land_years + ' yr incl. land</div>' : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="muted">No candidates yet. You need: (1) roads loaded — press "Refresh roads",
    (2) captured lands WITH coordinates within 1.5 km of a new road. Capture listings with the extension, add lat/lon in the Land database.</td></tr>`;
}

document.getElementById('bb-reload').addEventListener('click', loadSuggestions);
document.getElementById('bb-country').addEventListener('change', loadSuggestions);
document.getElementById('bb-all').addEventListener('change', loadSuggestions);
fillCountries(document.getElementById('bb-country'));

loadConfig().then(loadSuggestions).catch((e) => {
  document.getElementById('bb-count').textContent = 'failed: ' + e.message;
});
