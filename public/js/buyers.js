// Buyers page: criteria table + company cards with country/sector filters.
'use strict';

renderNav('buyers');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function num(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }

let data = null;
let country = '';

const SECTOR_LABEL = {
  'fuel-ev': 'Fuel & EV', 'retail-food': 'Retail & food',
  'hotel-rest': 'Hotels', 'auto-logistics': 'Auto & logistics',
};

function renderCategories() {
  document.querySelector('#cat-table tbody').innerHTML = (data.categories || []).map((c) => `<tr>
    <td><b>${esc(c.label || c.category)}</b></td>
    <td style="white-space:nowrap">${num(c.min_size_m2)} – ${num(c.max_size_m2)}</td>
    <td style="white-space:nowrap">${c.max_distance_from_road_m === 0 ? 'frontage' : num(c.max_distance_from_road_m) + ' m'}</td>
    <td class="small">${esc(c.requirements)}</td>
    <td class="small muted">${esc(c.why_premium || '')}</td>
  </tr>`).join('');
}

function renderCompanies() {
  const sector = document.getElementById('co-sector').value;
  const list = (data.companies || []).filter((c) =>
    (!sector || c.sector === sector) &&
    (!country || (c.countries || []).includes(country)));
  document.getElementById('co-grid').innerHTML = list.map((c) => `<div class="card">
    <h3 style="margin:0">${esc(c.name)}
      <span class="badge badge-blue">${esc(SECTOR_LABEL[c.sector] || c.sector)}</span>
      ${(c.countries || []).map((x) => `<span class="badge badge-purple">${esc(x)}</span>`).join(' ')}
    </h3>
    <p class="small" style="margin:8px 0 4px"><b>Looks for:</b> ${esc(c.looking_for || '')}</p>
    <p class="small muted" style="margin:4px 0"><b>Signals:</b> ${esc(c.expansion_signals || '')}</p>
    <p class="small" style="margin:4px 0 0"><b>Contact:</b> ${esc(c.contact_hint || '')}</p>
  </div>`).join('') || '<div class="muted">No companies for this filter.</div>';
}

async function load() {
  data = await API.get('/api/buyers');
  renderCategories();
  const countries = [...new Set((data.companies || []).flatMap((c) => c.countries || []))].sort();
  document.getElementById('co-chips').innerHTML =
    `<span class="chip active" data-c="">All countries</span>` +
    countries.map((c) => `<span class="chip" data-c="${c}">${c}</span>`).join(' ');
  document.getElementById('co-chips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip'); if (!chip) return;
    country = chip.dataset.c;
    document.querySelectorAll('#co-chips .chip').forEach((x) => x.classList.toggle('active', x === chip));
    renderCompanies();
  });
  document.getElementById('co-sector').addEventListener('change', renderCompanies);
  renderCompanies();
}
load();
