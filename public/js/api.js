// window.API — tiny fetch wrappers used by every page.
// All methods return parsed JSON; on !ok they throw Error(message) where
// message comes from the server's {"error": "..."} body when available.
'use strict';

(function () {
  async function request(method, path, body) {
    const opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error('Network error: ' + e.message);
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      const msg = (data && data.error) ? data.error : (method + ' ' + path + ' failed (' + res.status + ')');
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  window.API = {
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body); },
    patch: function (path, body) { return request('PATCH', path, body); },
    del: function (path) { return request('DELETE', path); }
  };

  // Fill a <select> with the tracked countries (enabled first). Keeps any existing
  // "All" option that has value="". Used by every page's country dropdown.
  let countriesCache = null;
  window.fillCountries = async function (selectEl, opts) {
    if (!selectEl) return;
    try {
      if (!countriesCache) countriesCache = await window.API.get('/api/countries');
      const keep = Array.prototype.filter.call(selectEl.options, function (o) { return o.value === ''; });
      selectEl.innerHTML = '';
      keep.forEach(function (o) { selectEl.appendChild(o); });
      const list = countriesCache.filter(function (c) { return c.enabled || (opts && opts.includeDisabled); });
      list.sort(function (a, b) {
        const focus = { ME: 0, RS: 1, MK: 2 };
        const fa = focus[a.iso2] !== undefined ? focus[a.iso2] : 99;
        const fb = focus[b.iso2] !== undefined ? focus[b.iso2] : 99;
        return fa - fb || a.name.localeCompare(b.name);
      });
      list.forEach(function (c) {
        const o = document.createElement('option');
        o.value = c.iso2;
        o.textContent = c.iso2 + ' — ' + c.name;
        selectEl.appendChild(o);
      });
    } catch (e) { /* keep whatever static options the page had */ }
  };
})();
