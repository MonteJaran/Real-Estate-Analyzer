// Shared top navbar. Every page calls renderNav('<id>') with one of:
// dash | map | lands | buyers | apis. Injects into <div id="nav"></div>.
// Includes the "Refresh roads" button: POST /api/roads/refresh, then poll
// GET /api/refresh/status every 3s while a job runs (spinner + job text).
'use strict';

(function () {
  const LINKS = [
    { id: 'dash', href: '/', label: 'Dashboard' },
    { id: 'map', href: '/map.html', label: 'Map' },
    { id: 'lands', href: '/lands.html', label: 'Land' },
    { id: 'dupes', href: '/duplicates.html', label: 'Duplicates' },
    { id: 'buyers', href: '/buyers.html', label: 'Buyers' },
    { id: 'billboards', href: '/billboards.html', label: 'Billboards' },
    { id: 'apis', href: '/apis.html', label: 'API status' }
  ];

  let pollTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderNav(activeId) {
    const el = document.getElementById('nav');
    if (!el) return;
    const links = LINKS.map(function (l) {
      const cls = 'nav-link' + (l.id === activeId ? ' active' : '');
      return '<a class="' + cls + '" href="' + l.href + '">' + l.label + '</a>';
    }).join('');
    el.innerHTML =
      '<nav class="navbar">' +
      '  <div class="navbar-inner">' +
      '    <a class="navbar-brand" href="/">Real Estate Booster</a>' +
      '    <div class="navbar-links">' + links + '</div>' +
      '    <div class="navbar-right">' +
      '      <span id="nav-refresh-state" class="nav-refresh-state muted" style="display:none">' +
      '        <span class="spinner"></span> <span id="nav-refresh-text"></span>' +
      '      </span>' +
      '      <button id="nav-refresh-btn" class="btn btn-primary btn-sm" type="button">Refresh roads</button>' +
      '    </div>' +
      '  </div>' +
      '</nav>';

    document.getElementById('nav-refresh-btn').addEventListener('click', onRefreshClick);
    // If a job is already running (started elsewhere), pick it up immediately.
    checkStatus();
  }

  async function onRefreshClick() {
    const btn = document.getElementById('nav-refresh-btn');
    if (btn) btn.disabled = true;
    try {
      await API.post('/api/roads/refresh', {});
    } catch (e) {
      // 409 = a job is already running — polling below will show it.
      if (e.status !== 409) {
        if (btn) btn.disabled = false;
        alert('Refresh failed: ' + e.message);
        return;
      }
    }
    checkStatus();
  }

  function showRunning(running) {
    const state = document.getElementById('nav-refresh-state');
    const text = document.getElementById('nav-refresh-text');
    const btn = document.getElementById('nav-refresh-btn');
    if (!state || !text) return;
    if (running) {
      state.style.display = '';
      text.textContent = running.type + (running.country ? ' · ' + running.country : ' · all');
      if (btn) btn.disabled = true;
    } else {
      state.style.display = 'none';
      text.textContent = '';
      if (btn) btn.disabled = false;
    }
  }

  async function checkStatus() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    let running = null;
    try {
      const st = await API.get('/api/refresh/status');
      running = st && st.running ? st.running : null;
    } catch (e) {
      running = null; // treat errors as idle; stop polling
    }
    showRunning(running);
    if (running) pollTimer = setTimeout(checkStatus, 3000);
  }

  window.renderNav = renderNav;
})();
