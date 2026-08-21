// Popup: inject content.js into the active tab, prefill the form with whatever
// it extracted, let the user fix fields, POST to the local Booster server.
'use strict';

const SERVER = 'http://localhost:3210';
let pageData = null;

const $ = (id) => document.getElementById(id);
const msg = (t, cls) => { const el = $('msg'); el.textContent = t; el.className = cls || ''; };

function fill(data) {
  pageData = data || {};
  $('f-url').value = pageData.url || '';
  $('f-title').value = pageData.title || '';
  if (pageData.price_eur != null) $('f-price').value = pageData.price_eur;
  if (pageData.size_m2 != null) $('f-size').value = pageData.size_m2;
  if (pageData.lat != null) $('f-lat').value = pageData.lat;
  if (pageData.lon != null) $('f-lon').value = pageData.lon;
  $('f-location').value = pageData.location_text || '';
  $('f-owner').value = pageData.owner_contact || '';
  $('f-desc').value = (pageData.description || '').slice(0, 1500);
}

async function extract() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
      msg('Open a listing page first, then press the button.', 'err');
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    const data = results && results[0] ? results[0].result : null;
    if (data) {
      fill(data);
      if (data.lat != null && data.lon != null) {
        // Coordinates found → save immediately; editing a field and pressing
        // Save later just updates the same row (upsert by URL).
        msg('Coordinates found — saving automatically…', '');
        await doSave(true);
      } else {
        msg('Parsed what I could — check the fields, fix, save.', '');
      }
    } else {
      fill({ url: tab.url, title: tab.title });
      msg('Could not parse this page — fill the fields manually.', 'err');
    }
  } catch (e) {
    msg('Extraction failed (' + e.message + ') — fill manually; URL is still captured.', 'err');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      pageData = { url: tab ? tab.url : null, source_site: tab && tab.url ? new URL(tab.url).hostname : null };
      $('f-title').value = (tab && tab.title) || '';
    } catch (e2) { pageData = {}; }
    if (pageData.url) $('f-url').value = pageData.url;
  }
}

async function doSave(auto) {
  $('save').disabled = true;
  if (!auto) msg('Saving…');
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  const body = {
    url: $('f-url').value.trim() || (pageData && pageData.url) || null,
    source_site: (pageData && pageData.source_site) || null,
    title: $('f-title').value.trim() || null,
    price_eur: num('f-price'),
    size_m2: num('f-size'),
    lat: num('f-lat'),
    lon: num('f-lon'),
    country: $('f-country').value || null,
    contents: $('f-contents').value,
    location_text: $('f-location').value.trim() || null,
    owner_contact: $('f-owner').value.trim() || null,
    description: $('f-desc').value.trim() || null,
    images: (pageData && pageData.images) || [],
    raw: pageData || {},
  };
  try {
    const res = await fetch(SERVER + '/api/lands/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    let extra = '';
    if (data.distance_to_road_m != null) extra += `\n→ ${Math.round(data.distance_to_road_m)} m from the nearest new road`;
    if (data.future_price_eur != null) extra += `\n→ est. future price ${Math.round(data.future_price_eur).toLocaleString('en')} €`;
    if (data.distance_to_road_m == null && body.lat != null) extra += '\n(no tracked road within 30 km)';
    if (body.lat == null) extra += '\n(add coordinates later to compute road distance)';
    msg((auto ? 'Auto-saved ✓' : 'Saved ✓') + ' (land #' + data.id + ')' + extra +
      (auto ? '\nEdit any field and press Save to update.' : ''), 'ok');
    chrome.storage.local.set({ lastCountry: $('f-country').value });
  } catch (e) {
    msg('Save failed: ' + e.message + '\nIs the Booster server running? (npm start → http://localhost:3210)', 'err');
  } finally {
    $('save').disabled = false;
  }
}

$('save').addEventListener('click', () => doSave(false));

// Country dropdown mirrors the app's tracked countries (fallback: static list in the HTML).
async function fillCountries() {
  try {
    const res = await fetch(SERVER + '/api/countries');
    const list = await res.json();
    const sel = $('f-country');
    const auto = sel.querySelector('option[value=""]');
    sel.innerHTML = '';
    if (auto) sel.appendChild(auto);
    const focus = { ME: 0, RS: 1, MK: 2 };
    list.filter((c) => c.enabled)
      .sort((a, b) => (focus[a.iso2] ?? 99) - (focus[b.iso2] ?? 99) || a.name.localeCompare(b.name))
      .forEach((c) => {
        const o = document.createElement('option');
        o.value = c.iso2;
        o.textContent = c.iso2 + ' — ' + c.name;
        sel.appendChild(o);
      });
  } catch (e) { /* server down: keep the static options */ }
}

chrome.storage.local.get('lastCountry', async (v) => {
  await fillCountries();
  if (v && v.lastCountry) $('f-country').value = v.lastCountry;
  extract();
});
