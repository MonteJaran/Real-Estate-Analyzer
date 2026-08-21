// Government/news announcement scraping. Fetches each road_sources entry of a
// country, collects links whose text matches the country's keywords
// (diacritics-insensitive), and stores them in the announcements table.
'use strict';

const cheerio = require('cheerio');
const db = require('../db');

const USER_AGENT = 'RealEstateBooster/1.0 (personal research tool)';
const FETCH_TIMEOUT_MS = 30000;
const POLITENESS_DELAY_MS = 2000;
const MAX_TITLE_LEN = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lowercase + strip combining diacritics (č→c, š→s, ž→z, Greek accents, ...).
// đ does not decompose under NFD, so map it by hand.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'dj');
}

function matchedKeywords(text, normKeywords) {
  const t = normalize(text);
  const hits = [];
  for (const kw of normKeywords) {
    if (kw.norm && t.includes(kw.norm)) hits.push(kw.raw);
  }
  return hits;
}

function extractHtmlLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href]').each((_, a) => {
    const title = $(a).text().replace(/\s+/g, ' ').trim();
    const href = ($(a).attr('href') || '').trim();
    if (!title || !href) return;
    if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch (e) {
      return;
    }
    out.push({ title: title.slice(0, MAX_TITLE_LEN), url: abs });
  });
  return out;
}

function extractRssItems(xml, baseUrl) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  $('item, entry').each((_, it) => {
    const title = $(it).find('title').first().text().replace(/\s+/g, ' ').trim();
    let link = $(it).find('link').first().text().trim();
    if (!link) link = ($(it).find('link').first().attr('href') || '').trim();
    if (!title || !link) return;
    let abs;
    try {
      abs = new URL(link, baseUrl).href;
    } catch (e) {
      return;
    }
    out.push({ title: title.slice(0, MAX_TITLE_LEN), url: abs });
  });
  return out;
}

// countryCfg is one entry of countries.json. Returns {country, newCount}.
async function refreshAnnouncements(countryCfg) {
  const iso2 = countryCfg.iso2;
  const normKeywords = (countryCfg.keywords || []).map((k) => ({ raw: k, norm: normalize(k) }));
  const insert = db
    .getDb()
    .prepare(
      'INSERT OR IGNORE INTO announcements (country, source_name, url, title, matched_keywords, found_at) VALUES (?,?,?,?,?,?)'
    );
  const sources = countryCfg.road_sources || [];
  let newCount = 0;

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const apiName = `source:${iso2}:${src.name}`;
    if (src.scrape_method !== 'static_html' && src.scrape_method !== 'rss') {
      db.logApi(apiName, src.url, true, 0, 0, 'needs_js — skipped');
      continue;
    }
    const start = Date.now();
    try {
      const res = await fetch(src.url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.text();
      const base = res.url || src.url;
      const links =
        src.scrape_method === 'rss' ? extractRssItems(body, base) : extractHtmlLinks(body, base);

      let srcNew = 0;
      const seenUrls = new Set();
      for (const link of links) {
        if (seenUrls.has(link.url)) continue;
        seenUrls.add(link.url);
        const hits = matchedKeywords(link.title, normKeywords);
        if (!hits.length) continue;
        const r = insert.run(iso2, src.name, link.url, link.title, hits.join(','), db.nowIso());
        if (r.changes > 0) srcNew++;
      }
      newCount += srcNew;
      db.logApi(apiName, src.url, true, Date.now() - start, srcNew, `${links.length} links scanned`);
    } catch (e) {
      db.logApi(apiName, src.url, false, Date.now() - start, 0, e.message);
    }
    if (i < sources.length - 1) await sleep(POLITENESS_DELAY_MS);
  }

  return { country: iso2, newCount };
}

module.exports = { refreshAnnouncements };
