// Alt+D injection: capture the SELECTED text as a listing. The whole file is one
// IIFE expression — executeScript returns its value. Parses price/size/phone
// from the selection; coordinates hunted from map embeds in the page HTML.
(() => {
  const sel = window.getSelection ? String(window.getSelection()).trim() : '';
  if (!sel) return null; // background shows the "?" badge

  const parseNum = (s) => {
    if (s == null) return null;
    let t = String(s).replace(/[^\d.,]/g, '');
    if (!t) return null;
    if (t.includes(',') && t.includes('.')) {
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

  const out = {
    url: location.href,
    source_site: location.hostname.replace(/^www\./, ''),
    title: (sel.split('\n')[0] || document.title || '').slice(0, 140),
    description: sel.slice(0, 3000),
    price_eur: null,
    size_m2: null,
    lat: null,
    lon: null,
    owner_contact: null,
    raw: { captured_via: 'selection' },
  };

  // price / size / phone from the SELECTION
  try {
    const m = sel.match(/(?:€|EUR)\s*([\d][\d\s.,]{2,15})/i) || sel.match(/([\d][\d\s.,]{2,15})\s*(?:€|EUR)/i);
    if (m) out.price_eur = parseNum(m[1]);
    const ha = sel.match(/([\d][\d\s.,]{0,10})\s*(?:ha|hektar)/i);
    const ari = sel.match(/([\d][\d\s.,]{0,10})\s*(?:ari|ара|ár)\b/i);
    const m2 = sel.match(/([\d][\d\s.,]{0,12})\s*(?:m2|m²|м2|кв\.?м)/i);
    if (m2) out.size_m2 = parseNum(m2[1]);
    else if (ari) { const n = parseNum(ari[1]); if (n) out.size_m2 = n * 100; }
    else if (ha) { const n = parseNum(ha[1]); if (n && n < 1000) out.size_m2 = n * 10000; }
    const ph = sel.match(/(\+?3[8-9][0-9][\d\s\/-]{7,13}|0[6-7][\d\s\/-]{7,10})/);
    if (ph) out.owner_contact = ph[1].trim();
    // coordinates pasted directly in the text, e.g. "42.399832, 18.580415"
    const co = sel.match(/(-?\d{1,2}\.\d{4,12})\s*,\s*(-?\d{1,3}\.\d{4,12})/);
    if (co) {
      const la = Number(co[1]), lo = Number(co[2]);
      if (la > 34 && la < 72 && lo > -11 && lo < 45) { out.lat = la; out.lon = lo; }
    }
  } catch (e) { /* keep going */ }

  // coordinates from map embeds in the page (same patterns as the full capture)
  try {
    if (out.lat == null) {
      const html = document.documentElement.innerHTML;
      const patterns = [
        /[?&;#](?:saddr|daddr|q|ll|center|markers?)=(-?\d{1,2}\.\d{3,12})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{3,12})/gi,
        /!3d(-?\d{1,2}\.\d{3,12})!4d(-?\d{1,3}\.\d{3,12})/gi,
        /!1s(-?\d{1,2}\.\d{3,12})\s*(?:,|%2C)\s*(-?\d{1,3}\.\d{3,12})/gi,
        /marker=(-?\d{1,2}\.\d{3,12})(?:,|%2C)(-?\d{1,3}\.\d{3,12})/gi,
        /"lat(?:itude)?"\s*:\s*(-?\d{1,2}\.\d{3,12})\s*,\s*"l(?:o?ng|on)(?:itude)?"\s*:\s*(-?\d{1,3}\.\d{3,12})/gi,
        /@(-?\d{1,2}\.\d{3,12}),(-?\d{1,3}\.\d{3,12})/g,
      ];
      outer:
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
          const la = Number(m[1]), lo = Number(m[2]);
          if (la > 34 && la < 72 && lo > -11 && lo < 45) { out.lat = la; out.lon = lo; break outer; }
        }
      }
    }
  } catch (e) { /* keep going */ }

  if (out.price_eur != null && (out.price_eur < 100 || out.price_eur > 100000000)) out.price_eur = null;
  if (out.size_m2 != null && (out.size_m2 < 10 || out.size_m2 > 100000000)) out.size_m2 = null;
  return out;
})();
