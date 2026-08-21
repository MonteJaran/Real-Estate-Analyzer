// Duplicates page: groups of lands captured at the same location (same plot on
// several portals). Server does the clustering: /api/lands/duplicates.
'use strict';

renderNav('dupes');

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function eur(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }
function num(n){ return n == null ? '–' : Math.round(n).toLocaleString('en'); }

function groupCard(g, idx) {
  const spreadTxt = g.spread_m === 0 ? 'identical coordinates' : `±${g.spread_m} m spread`;
  let priceTxt = '';
  if (g.price_min != null && g.price_max != null && g.price_max > g.price_min) {
    const diff = Math.round(((g.price_max - g.price_min) / g.price_min) * 100);
    priceTxt = ` · prices €${eur(g.price_min)}–€${eur(g.price_max)} <span class="badge badge-orange">${diff}% apart — negotiate from the lower one</span>`;
  } else if (g.price_min != null) {
    priceTxt = ` · €${eur(g.price_min)}`;
  }
  const rows = g.lands.map((l) => {
    const hasLink = l.url && !String(l.url).startsWith('manual:');
    return `<tr>
      <td>${hasLink ? `<a href="${esc(l.url)}" target="_blank" rel="noopener"><b>${esc(l.title || '(no title)')}</b></a>` : `<b>${esc(l.title || '(no title)')}</b>`}
        <div class="muted small">${esc(l.location_text || '')}</div></td>
      <td class="small">${esc(l.source_site || '–')}</td>
      <td>${eur(l.price_eur)}</td>
      <td>${num(l.size_m2)}</td>
      <td>${l.price_per_m2 != null ? l.price_per_m2 : '–'}</td>
      <td class="small">${esc(l.contact_status || '')}</td>
      <td class="muted small">${esc((l.captured_at || '').slice(0, 10))}</td>
      <td style="white-space:nowrap">
        <a class="btn btn-sm" href="/lands.html#land-${l.id}">open</a>
        <button class="btn btn-danger btn-sm" onclick="delLand(${l.id})">delete</button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="card" style="margin-bottom:14px">
    <h3 style="margin-top:0">Group ${idx + 1} — ${g.count} listings · ${spreadTxt}${priceTxt}
      <span class="muted small">· ${g.center.lat.toFixed(5)}, ${g.center.lon.toFixed(5)}</span></h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Listing</th><th>Source</th><th>Price €</th><th>Size m²</th><th>€/m²</th><th>Contact</th><th>Captured</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

async function load() {
  const radius = document.getElementById('d-radius').value;
  const country = document.getElementById('d-country').value;
  const qs = new URLSearchParams({ radius });
  if (country) qs.set('country', country);
  document.getElementById('d-count').innerHTML = '<span class="spinner"></span>';
  try {
    const res = await API.get('/api/lands/duplicates?' + qs.toString());
    document.getElementById('d-count').textContent =
      `${res.groups.length} duplicate group(s) at radius ${res.radius} m`;
    document.getElementById('d-groups').innerHTML = res.groups.length
      ? res.groups.map(groupCard).join('')
      : '<div class="card muted">No duplicates found — every captured land sits at a unique location (or lacks coordinates).</div>';
  } catch (e) {
    document.getElementById('d-count').textContent = 'failed: ' + e.message;
  }
}

window.delLand = async function (id) {
  if (!confirm('Delete land #' + id + '?')) return;
  try { await API.del('/api/lands/' + id); load(); } catch (e) { alert(e.message); }
};

document.getElementById('d-reload').addEventListener('click', load);
document.getElementById('d-radius').addEventListener('change', load);
document.getElementById('d-country').addEventListener('change', load);
fillCountries(document.getElementById('d-country'));
load();
