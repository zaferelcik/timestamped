"use strict";

/* ------------------------------------------------------------------ *
 * Timestamped — publish date finder
 *
 * Pipeline:
 *   1. Inject a scraper into the active tab and collect every date
 *      signal: <meta>, JSON-LD, <time>, the URL path, and visible
 *      "Published on …" text (English + Turkish).
 *   2. Score candidates. Publish-date signals rank high; modified/
 *      updated signals are kept but capped so they can never be
 *      mistaken for the publish date — they're surfaced separately.
 *   3. If the page already gave a strong date, skip the network.
 *      Otherwise query the Wayback Machine (with a timeout) for the
 *      first-archived date as an upper bound.
 *   4. Render the best publish date, an optional "Last modified"
 *      line, a confidence meter, and an expandable list of all
 *      signals. Results are cached for 12h.
 *
 * Everything is bounded by timeouts, so the popup never hangs.
 * ------------------------------------------------------------------ */

const STRONG_ENOUGH = 85; // skip Wayback at/above this confidence
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const state = { result: null, tabUrl: "" };

/* ================================================================== *
 *  1. PAGE SCRAPER  (serialised and run INSIDE the page)
 * ================================================================== */
function extractSignals() {
  const signals = [];
  const seen = new Set();
  const add = (label, raw, confidence, kind, role = "publish") => {
    if (raw == null) return;
    const value = String(raw).replace(/\s+/g, " ").trim();
    if (!value || value.length > 240) return;
    const key = (label + "|" + value).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    signals.push({ label, raw: value, confidence, kind, role });
  };

  // -- <meta> tags
  const META_RULES = [
    { attr: "property", names: ["article:published_time"], label: "article:published_time", conf: 92, role: "publish" },
    { attr: "property", names: ["og:published_time"], label: "og:published_time", conf: 88, role: "publish" },
    { attr: "property", names: ["article:published", "vr:published_time"], label: "publisher publish meta", conf: 82, role: "publish" },
    { attr: "name", names: ["dc.date.issued", "dcterms.issued", "dcterms.created", "dcterms.available", "dcterms.date", "dc.date"], label: "Dublin Core date", conf: 84, role: "publish" },
    { attr: "name", names: ["date", "publish_date", "publication_date", "pubdate", "publishdate", "publish-date", "sailthru.date", "parsely-pub-date", "timestamp"], label: "date metadata", conf: 78, role: "publish" },
    { attr: "itemprop", names: ["datepublished"], label: "schema.org datePublished", conf: 90, role: "publish" },
    { attr: "itemprop", names: ["datecreated"], label: "schema.org dateCreated", conf: 86, role: "publish" },
    // modified / updated — captured but flagged so they never win publish
    { attr: "property", names: ["article:modified_time", "og:updated_time"], label: "article:modified_time", conf: 70, role: "modified" },
    { attr: "itemprop", names: ["datemodified"], label: "schema.org dateModified", conf: 70, role: "modified" },
  ];
  for (const meta of document.querySelectorAll("meta")) {
    const content = meta.getAttribute("content") || meta.getAttribute("value");
    for (const rule of META_RULES) {
      const v = (meta.getAttribute(rule.attr) || "").toLowerCase();
      if (rule.names.includes(v)) add(rule.label, content, rule.conf, "meta", rule.role);
    }
  }

  // -- <time> elements
  for (const node of document.querySelectorAll("time")) {
    const raw = node.getAttribute("datetime") || node.getAttribute("content") || node.textContent;
    const itemprop = (node.getAttribute("itemprop") || "").toLowerCase();
    if (itemprop === "datemodified") {
      add("<time> modified", raw, 60, "time", "modified");
    } else {
      const strong = itemprop === "datepublished" || node.hasAttribute("pubdate");
      add(strong ? "time[itemprop=datePublished]" : "<time> element", raw, strong ? 85 : 66, "time", "publish");
    }
  }

  // -- JSON-LD
  const walk = (val) => {
    if (!val) return;
    if (Array.isArray(val)) return void val.forEach(walk);
    if (typeof val !== "object") return;
    const type = String(val["@type"] || "").toLowerCase();
    const boost = /article|posting|news|report|creativework|blog/.test(type) ? 4 : 0;
    if (val.datePublished) add("JSON-LD datePublished", String(val.datePublished), 93 + boost, "json-ld", "publish");
    if (val.dateCreated) add("JSON-LD dateCreated", String(val.dateCreated), 86 + boost, "json-ld", "publish");
    if (val.uploadDate) add("JSON-LD uploadDate", String(val.uploadDate), 84 + boost, "json-ld", "publish");
    if (val.dateModified) add("JSON-LD dateModified", String(val.dateModified), 70, "json-ld", "modified");
    if (val["@graph"]) walk(val["@graph"]);
    for (const k of Object.keys(val)) if (val[k] && typeof val[k] === "object") walk(val[k]);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    const t = (s.textContent || "").replace(/^\s*<!--|-->\s*$/g, "").trim();
    if (!t) continue;
    try { walk(JSON.parse(t)); } catch { /* ignore bad JSON-LD */ }
  }

  // -- URL path date (e.g. /2021/11/13/) — canonical first
  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  for (const u of [canonical, location.href].filter(Boolean)) {
    add("URL date pattern", u, 62, "url", "publish");
  }

  // -- Visible "Published on …" text (EN + TR)
  const body = (document.body?.innerText || document.body?.textContent || "").slice(0, 6000);
  const PATTERNS = [
    /(?:published|posted)\s*(?:on|at)?\s*[:\-–]?\s*([A-Za-zÇĞİÖŞÜçğıöşü]{3,12}\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
    /(?:published|posted)\s*(?:on|at)?\s*[:\-–]?\s*(\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,12}\s+\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
    /(?:yayınlanma|yayın tarihi|yayımlanma)\s*[:\-–]?\s*(\d{1,2}\s+[A-Za-zÇĞİÖŞÜçğıöşü]{3,12}\s+\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
    /(?:published|posted|yayınlanma|yayın tarihi|yayımlanma)\s*[:\-–]?\s*(\d{4}[./-]\d{1,2}[./-]\d{1,2})/i,
    /(?:published|posted|yayınlanma|yayın tarihi|yayımlanma)\s*[:\-–]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i,
  ];
  for (const p of PATTERNS) {
    const m = body.match(p);
    if (m?.[1]) add("Visible 'published' text", m[1], 72, "visible", "publish");
  }
  // visible "Updated/Güncelleme" text → modified
  const MOD = [
    /(?:updated|last updated|güncelleme|güncellenme)\s*(?:on|at)?\s*[:\-–]?\s*([A-Za-zÇĞİÖŞÜçğıöşü0-9]{1,12}[\s./-]+[A-Za-zÇĞİÖŞÜçğıöşü0-9 ,:]{3,20}\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
  ];
  for (const p of MOD) {
    const m = body.match(p);
    if (m?.[1]) add("Visible 'updated' text", m[1], 55, "visible", "modified");
  }

  return signals;
}

/* ================================================================== *
 *  2. DATE PARSING  (popup context)
 * ================================================================== */
const MONTHS = {
  jan:1,january:1,ocak:1,oca:1, feb:2,february:2,şubat:2,subat:2,şub:2,sub:2,
  mar:3,march:3,mart:3, apr:4,april:4,nisan:4,nis:4, may:5,mayıs:5,mayis:5,
  jun:6,june:6,haziran:6,haz:6, jul:7,july:7,temmuz:7,tem:7,
  aug:8,august:8,ağustos:8,agustos:8,ağu:8,agu:8,
  sep:9,sept:9,september:9,eylül:9,eylul:9,eyl:9, oct:10,october:10,ekim:10,eki:10,
  nov:11,november:11,kasım:11,kasim:11,kas:11, dec:12,december:12,aralık:12,aralik:12,ara:12,
};

function makeUtc(y, m, d, h = 0, min = 0, s = 0) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d, h, min, s));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function isPlausible(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return false;
  const y = date.getUTCFullYear();
  if (y < 1990) return false;
  return date.getTime() <= Date.now() + 36 * 3600 * 1000; // allow tz slop
}

function parseUrlDate(value) {
  try {
    const path = decodeURIComponent(new URL(value, "https://x.example").pathname);
    const pats = [
      /(?:^|\/)(19\d{2}|20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\/|$)/,
      /(?:^|\/)(19\d{2}|20\d{2})(\d{2})(\d{2})(?:\/|$|-|_)/,
    ];
    for (const p of pats) {
      const m = path.match(p);
      if (m) { const d = makeUtc(+m[1], +m[2], +m[3]); if (d) return { date: d, bonus: -4 }; }
    }
  } catch { /* */ }
  return null;
}

function parseDate(raw, kind) {
  if (!raw) return null;
  let v = String(raw).trim();
  if (!v) return null;
  if (kind === "url") return parseUrlDate(v);

  v = v.replace(/\u00a0/g, " ").replace(/[|•]/g, " ")
       .replace(/(Güncelleme|Updated)\s*[:\-–].*$/i, "").replace(/\s+/g, " ").trim();

  let m = v.match(/\b(19\d{2}|20\d{2})(\d{2})(\d{2})\b/);
  if (m) { const d = makeUtc(+m[1], +m[2], +m[3]); if (d) return { date: d, bonus: 1 }; }

  m = v.match(/\b(19\d{2}|20\d{2})[./-](\d{1,2})[./-](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) { const d = makeUtc(+m[1], +m[2], +m[3], +(m[4]||0), +(m[5]||0), +(m[6]||0)); if (d) return { date: d, bonus: 2 }; }

  // dd.mm.yy(yy) — dot/slash/dash, EU ordering with US disambiguation
  m = v.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    let day = a, month = b;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { day = b; month = a; }
    const d = makeUtc(y, month, day, +(m[4]||0), +(m[5]||0), +(m[6]||0));
    if (d) return { date: d, bonus: 1 };
  }

  // "13 November 2021" or "November 13, 2021" (EN + TR months)
  m = v.match(/\b(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(19\d{2}|20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/i)
   || v.match(/\b([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{1,2}),?\s+(19\d{2}|20\d{2})(?:\s+(\d{1,2}):(\d{2}))?/i);
  if (m) {
    let day, mon, y, h = 0, mi = 0;
    if (/^\d/.test(m[1])) { day = +m[1]; mon = m[2]; y = +m[3]; h = +(m[4]||0); mi = +(m[5]||0); }
    else { mon = m[1]; day = +m[2]; y = +m[3]; h = +(m[4]||0); mi = +(m[5]||0); }
    const month = MONTHS[mon.toLocaleLowerCase("tr-TR").replace(/\./g, "")];
    const d = month ? makeUtc(y, month, day, h, mi) : null;
    if (d) return { date: d, bonus: 1 };
  }

  // ISO / RFC fallback
  if (/\b(19\d{2}|20\d{2})-\d{1,2}-\d{1,2}/.test(v) || /\b[A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/.test(v)) {
    const native = new Date(v);
    if (!isNaN(native.getTime())) return { date: native, bonus: 0 };
  }
  return null;
}

/* ================================================================== *
 *  3. SCORING
 * ================================================================== */
function evaluate(signals) {
  const parsed = [];
  for (const sig of signals) {
    const c = parseDate(sig.raw, sig.kind);
    if (!c || !isPlausible(c.date)) continue;
    let conf = Math.max(0, Math.min(99, sig.confidence + c.bonus));
    if (sig.role === "modified") conf = Math.min(conf, 60);
    parsed.push({ ...sig, date: c.date.toISOString(), confidence: conf });
  }

  const publish = parsed.filter((s) => s.role !== "modified");
  const modified = parsed.filter((s) => s.role === "modified");

  // best publish: highest confidence; near-ties broken toward earliest date
  publish.sort((a, b) => {
    if (Math.abs(b.confidence - a.confidence) > 8) return b.confidence - a.confidence;
    return new Date(a.date) - new Date(b.date);
  });
  // best modified: most recent
  modified.sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    best: publish[0] || null,
    bestModified: modified[0] || null,
    signals: parsed.sort((a, b) => b.confidence - a.confidence),
  };
}

/* ================================================================== *
 *  4. WAYBACK (with availability fallback)
 * ================================================================== */
function tsToIso(ts) {
  if (!/^\d{14}$/.test(ts)) return null;
  return `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}T${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}Z`;
}
async function waybackCdx(url) {
  const ep = "https://web.archive.org/cdx/search/cdx?" + new URLSearchParams({
    output: "json", fl: "timestamp", filter: "statuscode:200",
    limit: "1", sort: "ascending", url,
  });
  const res = await fetch(ep, { cache: "no-store" });
  if (!res.ok) throw new Error("cdx " + res.status);
  const rows = await res.json();
  const ts = Array.isArray(rows) && rows[1] ? rows[1][0] : null;
  return ts ? tsToIso(ts) : null;
}
async function waybackAvailability(url) {
  const ep = "https://archive.org/wayback/available?timestamp=19900101&url=" + encodeURIComponent(url);
  const res = await fetch(ep, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return tsToIso(data?.archived_snapshots?.closest?.timestamp || "");
}
async function waybackSignal(url) {
  let iso = null;
  try { iso = await waybackCdx(url); } catch { /* fall through */ }
  if (!iso) { try { iso = await waybackAvailability(url); } catch { /* */ } }
  return iso ? { label: "Wayback first snapshot", raw: iso, confidence: 55, kind: "archive", role: "publish" } : null;
}

/* ================================================================== *
 *  5. UTIL
 * ================================================================== */
function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); },
                                  (e) => { clearTimeout(t); reject(e); });
  });
}
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|gclid|mc_|igshid|ref$)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return url.split("#")[0]; }
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return String(h);
}

/* ================================================================== *
 *  6. RENDER
 * ================================================================== */
const $ = (id) => document.getElementById(id);

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "long", day: "numeric",
  });
}
function fmtShort(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function relative(iso) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 0) return "in the future";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")} years ago`;
}
function confidenceCopy(c) {
  if (c >= 85) return "High — from the page's own publish-date data";
  if (c >= 70) return "Medium — from page metadata or visible date";
  if (c >= 55) return "Low — inferred, treat as an estimate";
  return "Estimate — earliest web-archive snapshot";
}
function pipsFor(c) { return c >= 85 ? 4 : c >= 70 ? 3 : c >= 55 ? 2 : 1; }

function showState(name) {
  for (const s of ["loading", "result", "empty"]) $(s).hidden = s !== name;
}

function render(result) {
  state.result = result;
  $("signal-count").textContent = "";

  if (!result.best) {
    $("empty-msg").textContent = result.errorMsg ||
      "No publish date is exposed by this page, and the web archive has no record of it.";
    showState("empty");
    return;
  }

  const best = result.best;
  $("date-main").textContent = fmtDate(best.date);
  $("date-relative").textContent = relative(best.date);
  $("source-label").textContent = best.label;

  // confidence pips
  const onPips = pipsFor(best.confidence);
  const pips = $("confidence-pips");
  pips.innerHTML = "";
  for (let i = 1; i <= 4; i++) {
    const pip = document.createElement("span");
    pip.className = "pip" + (i <= onPips ? " on" : "");
    pips.appendChild(pip);
  }
  $("confidence-text").textContent = `${Math.round(best.confidence)}% · ${confidenceCopy(best.confidence)}`;

  // modified line
  const mod = result.bestModified;
  if (mod && fmtShort(mod.date) !== fmtShort(best.date)) {
    $("modified-row").hidden = false;
    $("modified-date").textContent = fmtShort(mod.date);
  } else {
    $("modified-row").hidden = true;
  }

  // signals list
  const list = $("signals");
  list.innerHTML = "";
  const top = result.signals.slice(0, 12);
  for (const s of top) {
    const li = document.createElement("li");
    const tag = s.role === "modified" ? "modified" : "publish";
    li.innerHTML =
      `<span class="sig-name">${escapeHtml(s.label)}</span>` +
      `<span class="sig-meta">${fmtShort(s.date)} · ${Math.round(s.confidence)}%` +
      (s.role === "modified" ? ` · <em>${tag}</em>` : "") + `</span>`;
    list.appendChild(li);
  }
  $("signal-count").textContent =
    result.signals.length === 1 ? "1 signal" : `${result.signals.length} signals`;

  $("copy-btn").disabled = false;
  showState("result");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ================================================================== *
 *  7. ORCHESTRATION
 * ================================================================== */
async function run({ bypassCache = false } = {}) {
  showState("loading");
  $("copy-btn").disabled = true;
  $("signals").innerHTML = "";

  let tab;
  try {
    [tab] = await withTimeout(
      chrome.tabs.query({ active: true, currentWindow: true }),
      2500, "Couldn't read the active tab"
    );
  } catch {
    return render({ best: null, signals: [], errorMsg: "Couldn't read the active tab." });
  }

  const url = tab?.url || "";
  if (!/^https?:\/\//i.test(url)) {
    return render({ best: null, signals: [], errorMsg: "Open a normal web page (http/https) and try again." });
  }
  state.tabUrl = url;
  const cacheKey = "ts:" + hashStr(normalizeUrl(url));

  // cache
  if (!bypassCache) {
    try {
      const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return render(cached.result);
    } catch { /* ignore */ }
  }

  // page scan (timeout-bounded)
  let pageSignals = [];
  try {
    const [res] = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: extractSignals }),
      3000, "Page scan timed out"
    );
    if (res && Array.isArray(res.result)) pageSignals = res.result;
  } catch (e) {
    if (/Cannot access|chrome:\/\/|extension/i.test(e.message || "")) {
      return render({ best: null, signals: [], errorMsg: "This page can't be inspected by extensions." });
    }
    // otherwise continue — Wayback may still help
  }

  let result = evaluate(pageSignals);

  // skip the network entirely if the page already gave us something strong
  if (!result.best || result.best.confidence < STRONG_ENOUGH) {
    try {
      const wb = await withTimeout(waybackSignal(normalizeUrl(url)), 2200, "Wayback timed out");
      if (wb) result = evaluate([...pageSignals, wb]);
    } catch { /* leave page-only result */ }
  }

  result.pageUrl = url;
  try { await chrome.storage.local.set({ [cacheKey]: { result, cachedAt: Date.now() } }); } catch { /* */ }
  render(result);
}

async function copyResult() {
  const b = state.result?.best;
  if (!b) return;
  const iso = new Date(b.date).toISOString().slice(0, 10);
  let text = `Published: ${iso} (${Math.round(b.confidence)}% — ${b.label})`;
  const m = state.result.bestModified;
  if (m && fmtShort(m.date) !== fmtShort(b.date)) text += `\nLast modified: ${new Date(m.date).toISOString().slice(0, 10)}`;
  text += `\n${state.tabUrl}`;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $("copy-btn");
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = "Copy"; }, 1200);
  } catch { /* */ }
}

document.addEventListener("DOMContentLoaded", () => {
  $("refresh-btn").addEventListener("click", () => run({ bypassCache: true }));
  $("copy-btn").addEventListener("click", copyResult);
  $("details").addEventListener("toggle", (e) => {
    $("details-toggle").setAttribute("aria-expanded", e.target.open ? "true" : "false");
  });
  run();
});
