// Extraction script injected into the active tab. The WHOLE FILE evaluates to
// one IIFE expression — chrome.scripting.executeScript returns its value.
// Best-effort extraction chain: JSON-LD → OpenGraph → site parsers → generic
// price/size regex → Facebook post text. Never throws.
(() => {
  const out = {
    url: location.href,
    source_site: location.hostname.replace(/^www\./, ''),
    title: document.title || null,
    price_eur: null,
    size_m2: null,
    lat: null,
    lon: null,
    location_text: null,
    description: null,
    owner_contact: null,
    images: [],
  };

  const text = (el) => (el && el.textContent ? el.textContent.trim() : null);
  const attr = (sel, a) => { const el = document.querySelector(sel); return el ? el.getAttribute(a) : null; };

  // Parse "1.250.000", "1,250,000", "1 250 000", "1.5" into a number (EU formats).
  const parseNum = (s) => {
    if (s == null) return null;
    let t = String(s).replace(/[^\d.,]/g, '');
    if (!t) return null;
    if (t.includes(',') && t.includes('.')) {
      // last separator is the decimal one
      if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else if (t.includes(',')) {
      const parts = t.split(',');
      t = parts[parts.length - 1].length === 3 && parts.length > 1 ? t.replace(/,/g, '') : t.replace(',', '.');
    } else if ((t.match(/\./g) || []).length > 1) {
      t = t.replace(/\./g, '');
    } else if (t.includes('.') && t.split('.')[1].length === 3) {
      t = t.replace('.', '');
    }
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // ---- 1. JSON-LD ----
  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (e) { continue; }
      const list = Array.isArray(data) ? data : [data];
      for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        const offer = d.offers || d;
        if (offer.price != null && out.price_eur == null) {
          const cur = (offer.priceCurrency || '').toUpperCase();
          const p = parseNum(offer.price);
          if (p && (cur === 'EUR' || cur === '')) out.price_eur = p;
        }
        if (d.name && !out.location_text && d['@type'] !== 'BreadcrumbList') out.title = out.title || d.name;
        const g = d.geo || (d.address && d.address.geo);
        if (g && g.latitude != null && out.lat == null) { out.lat = Number(g.latitude); out.lon = Number(g.longitude); }
        if (d.address && typeof d.address === 'object' && !out.location_text) {
          out.location_text = [d.address.addressLocality, d.address.addressRegion].filter(Boolean).join(', ') || null;
        }
        if (d.description && !out.description) out.description = String(d.description).slice(0, 3000);
        if (d.image) {
          const imgs = Array.isArray(d.image) ? d.image : [d.image];
          for (const im of imgs.slice(0, 8)) if (typeof im === 'string') out.images.push(im);
        }
      }
    }
  } catch (e) { /* continue */ }

  // ---- 2. OpenGraph ----
  try {
    out.title = attr('meta[property="og:title"]', 'content') || out.title;
    if (!out.description) {
      const d = attr('meta[property="og:description"]', 'content') || attr('meta[name="description"]', 'content');
      if (d) out.description = d.slice(0, 3000);
    }
    const ogImg = attr('meta[property="og:image"]', 'content');
    if (ogImg && !out.images.length) out.images.push(ogImg);
  } catch (e) { /* continue */ }

  // ---- 3. Site-specific parsers (best-effort, each isolated) ----
  const host = location.hostname;
  try {
    if (host.includes('halooglasi.com')) {
      // Exact coordinates live in the embedded QuidditaEnvironment JSON.
      const m = document.documentElement.innerHTML.match(/"GeoLocationRPT"\s*:\s*"([\d.]+),([\d.]+)"/);
      if (m) { out.lat = Number(m[1]); out.lon = Number(m[2]); }
      const price = text(document.querySelector('.offer-price-value')) ||
        (document.documentElement.innerHTML.match(/"cena_d"\s*:\s*([\d.]+)/) || [])[1];
      if (price && out.price_eur == null) out.price_eur = parseNum(price);
      const size = (document.documentElement.innerHTML.match(/"povrsina_d"\s*:\s*([\d.]+)/) || [])[1];
      if (size && out.size_m2 == null) out.size_m2 = parseNum(size);
    } else if (host.includes('4zida.rs')) {
      const price = text(document.querySelector('[class*="price"]'));
      if (price && out.price_eur == null) out.price_eur = parseNum(price);
    } else if (host.includes('facebook.com')) {
      const art = document.querySelector('[role="article"]');
      if (art && !out.description) out.description = art.innerText.slice(0, 3000);
      out.title = out.title || 'Facebook post';
    }
  } catch (e) { /* continue */ }

  // ---- 3b. Map embeds: Google Maps iframes/links, OSM embeds, data-lat attrs ----
  // Real-estate sites rarely print coordinates but very often embed a map whose
  // URL contains them (e.g. maps.google.com/maps?saddr=42.399832,18.580415).
  try {
    if (out.lat == null) {
      const el = document.querySelector('[data-lat][data-lng], [data-lat][data-lon], [data-latitude][data-longitude]');
      if (el) {
        const la = Number(el.dataset.lat || el.dataset.latitude);
        const lo = Number(el.dataset.lng || el.dataset.lon || el.dataset.longitude);
        if (Number.isFinite(la) && Number.isFinite(lo)) { out.lat = la; out.lon = lo; }
      }
    }
    if (out.lat == null) {
      const html = document.documentElement.innerHTML;
      const patterns = [
        // ?saddr= / ?q= / ?ll= / ?center= / &markers= followed by "lat,lon" (Google embed iframes)
        /[?&;#](?:saddr|daddr|q|ll|center|markers?)=(-?\d{1,2}\.\d{3,12})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{3,12})/gi,
        // Google embed "pb" format: ...!3d42.399!4d18.580... (lat in !3d, lon in !4d)
        /!3d(-?\d{1,2}\.\d{3,12})!4d(-?\d{1,3}\.\d{3,12})/gi,
        // Google embed "pb" format variant: ...!1s42.399832,18.580415...
        /!1s(-?\d{1,2}\.\d{3,12})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{3,12})/gi,
        // OpenStreetMap embed: export/embed.html?...&marker=lat,lon
        /marker=(-?\d{1,2}\.\d{3,12})(?:,|%2C)(-?\d{1,3}\.\d{3,12})/gi,
        // JS map init: LatLng(42.39, 18.58) / setView([42.39, 18.58])
        /LatLng\(\s*(-?\d{1,2}\.\d{3,12})\s*,\s*(-?\d{1,3}\.\d{3,12})\s*\)/gi,
        /setView\(\s*\[\s*(-?\d{1,2}\.\d{3,12})\s*,\s*(-?\d{1,3}\.\d{3,12})\s*\]/gi,
        // "lat": 42.39, "lng"/"lon": 18.58 in embedded JSON
        /"lat(?:itude)?"\s*:\s*(-?\d{1,2}\.\d{3,12})\s*,\s*"l(?:o?ng|on)(?:itude)?"\s*:\s*(-?\d{1,3}\.\d{3,12})/gi,
        // Google Maps links: /maps/...@42.39,18.58,17z  (last — noisiest)
        /@(-?\d{1,2}\.\d{3,12}),(-?\d{1,3}\.\d{3,12})/g,
      ];
      outer:
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
          const la = Number(m[1]);
          const lo = Number(m[2]);
          // sanity box: Europe
          if (la > 34 && la < 72 && lo > -11 && lo < 45) { out.lat = la; out.lon = lo; break outer; }
        }
      }
    }
  } catch (e) { /* continue */ }

  // ---- 4. Generic price/size regex over visible text ----
  try {
    const body = document.body ? document.body.innerText.slice(0, 60000) : '';
    if (out.price_eur == null) {
      const m = body.match(/(?:€|EUR)\s*([\d][\d\s.,]{2,15})/i) || body.match(/([\d][\d\s.,]{2,15})\s*(?:€|EUR)/i);
      if (m) out.price_eur = parseNum(m[1]);
    }
    if (out.size_m2 == null) {
      const ha = body.match(/([\d][\d\s.,]{0,10})\s*(?:ha|hektar)/i);
      const ari = body.match(/([\d][\d\s.,]{0,10})\s*(?:ari|ара|ár)\b/i);
      const m2 = body.match(/([\d][\d\s.,]{0,12})\s*(?:m2|m²|м2|кв\.?м)/i);
      if (m2) out.size_m2 = parseNum(m2[1]);
      else if (ari) { const n = parseNum(ari[1]); if (n) out.size_m2 = n * 100; }
      else if (ha) { const n = parseNum(ha[1]); if (n && n < 1000) out.size_m2 = n * 10000; }
    }
    // phone number (Balkan formats) as owner contact hint
    if (!out.owner_contact) {
      const ph = body.match(/(\+?3[8-9][0-9][\d\s\/-]{7,13}|0[6-7][\d\s\/-]{7,10})/);
      if (ph) out.owner_contact = ph[1].trim();
    }
  } catch (e) { /* continue */ }

  // sanity limits
  if (out.price_eur != null && (out.price_eur < 100 || out.price_eur > 100000000)) out.price_eur = null;
  if (out.size_m2 != null && (out.size_m2 < 10 || out.size_m2 > 100000000)) out.size_m2 = null;
  if (out.lat != null && !(out.lat > 34 && out.lat < 72 && out.lon > -11 && out.lon < 45)) { out.lat = null; out.lon = null; }
  out.images = out.images.slice(0, 8);
  return out;
})();
