/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — script.js
   ══════════════════════════════════════════════════════════════ */

const HISTORY_KEY = 'cr_bridge_history';
const MAX_HISTORY = 10;

/* ── DOM refs ────────────────────────────────────────────────── */
const mapsInput   = document.getElementById('mapsInput');
const pasteBtn    = document.getElementById('pasteBtn');
const convertBtn  = document.getElementById('convertBtn');
const errorBox    = document.getElementById('errorMsg');
const resultEl    = document.getElementById('result');
const latEl       = document.getElementById('lat');
const lngEl       = document.getElementById('lng');
const successMsg  = document.getElementById('successMsg');
const copyBtn     = document.getElementById('copyBtn');
const historyList = document.getElementById('historyList');
const clearBtn    = document.getElementById('clearBtn');

let currentLat = null;
let currentLng = null;

/* ══════════════════════════════════════════════════════════════
   PASTE
   ══════════════════════════════════════════════════════════════ */
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    mapsInput.value = text.trim();
    mapsInput.focus();
  } catch {
    showError('Clipboard access denied — please paste the link manually (Ctrl+V).');
  }
});

/* ══════════════════════════════════════════════════════════════
   CONVERT
   ══════════════════════════════════════════════════════════════ */
convertBtn.addEventListener('click', () => handleConvert());
mapsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleConvert(); });

async function handleConvert() {
  const raw = mapsInput.value.trim();
  if (!raw) { showError('Please paste a Google Maps link first.'); return; }
  await convertLink(cleanUrl(raw));
}

// Strip Google tracking params (g_st, g_ep, etc.) from short URLs.
// e.g. maps.app.goo.gl/XYZ?g_st=ic  →  maps.app.goo.gl/XYZ
function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
      return `${u.origin}${u.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

async function convertLink(url) {
  setLoading(true);
  clearError();
  hideResult();

  try {
    let resolvedUrl = url;
    let coords = null;

    // Step 1: expand short URLs via Netlify function (server-side redirect + HTML parsing)
    if (isShortUrl(url)) {
      const resolved = await resolveShortUrl(url);
      resolvedUrl = resolved.finalUrl;
      coords = resolved.coords;
    }

    // Step 2: extract coords directly from the resolved URL
    if (!coords) coords = extractCoordsFromUrl(resolvedUrl);

    if (coords) {
      currentLat = coords.lat;
      currentLng = coords.lng;
      showResult(coords.lat, coords.lng);
      await copyToClipboard(`${coords.lat}, ${coords.lng}`);
      const placeName = extractPlaceName(resolvedUrl) || extractPlaceName(url);
      saveToHistory(coords.lat, coords.lng, url, placeName);
    } else {
      showError('Could not extract coordinates. Try opening the link in your browser and copying the full URL from the address bar.');
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   SHORT URL RESOLUTION
   ══════════════════════════════════════════════════════════════ */
function isShortUrl(url) {
  return /maps\.app\.goo\.gl|goo\.gl\/maps/.test(url);
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function extractFromHtml(html) {
  if (!html) return null;
  const ogUrl =
    html.match(/property="og:url"\s+content="([^"]+)"/)?.[1] ||
    html.match(/content="([^"]+)"\s+property="og:url"/)?.[1];
  if (ogUrl) return ogUrl.replace(/&amp;/g, '&');
  const canonical =
    html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1] ||
    html.match(/href="([^"]+)"\s+rel="canonical"/)?.[1];
  if (canonical) return canonical.replace(/&amp;/g, '&');
  return null;
}

// Returns { finalUrl: string, coords: {lat,lng}|null }
async function resolveShortUrl(url) {
  const encoded = encodeURIComponent(url);

  // ── Netlify serverless function (primary) ────────────────────
  try {
    const res = await fetchWithTimeout(`/.netlify/functions/resolve-url?url=${encoded}`, 8000);
    if (res.ok) {
      const data = await res.json();
      const coords = (data.lat && data.lng) ? { lat: data.lat, lng: data.lng } : null;
      return { finalUrl: data.finalUrl || url, coords };
    }
  } catch { /* fall through to proxies */ }

  // ── allorigins.win (fallback) ─────────────────────────────────
  try {
    const res = await fetchWithTimeout(`https://api.allorigins.win/get?url=${encoded}`, 7000);
    if (res.ok) {
      const data = await res.json();
      const finalUrl = (data.status?.url && data.status.url !== url)
        ? data.status.url
        : extractFromHtml(data.contents || '');
      if (finalUrl) return { finalUrl, coords: null };
    }
  } catch { /* try next */ }

  // ── corsproxy.io (last resort) ────────────────────────────────
  try {
    const res = await fetchWithTimeout(`https://corsproxy.io/?${encoded}`, 7000);
    if (res.ok) {
      const html = await res.text();
      const finalUrl = extractFromHtml(html);
      if (finalUrl) return { finalUrl, coords: null };
    }
  } catch { /* all methods exhausted */ }

  throw new Error(
    'Could not expand this short link. ' +
    'Open it in your browser, copy the full URL from the address bar, and paste that instead.'
  );
}

/* ══════════════════════════════════════════════════════════════
   URL PARSING
   ① /maps/place/Name/@lat,lng,zoom
   ② /maps/search/query/@lat,lng,zoom
   ③ data= blob: !3d{lat}!4d{lng}
   ④ ?q=lat,lng
   ⑤ ?ll=lat,lng
   ⑥ ?daddr=lat,lng
   ══════════════════════════════════════════════════════════════ */
function extractCoordsFromUrl(url) {
  const atMatch = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) return coord(atMatch[1], atMatch[2]);

  const dataMatch = url.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (dataMatch) return coord(dataMatch[1], dataMatch[2]);

  let u;
  try { u = new URL(url); } catch { return null; }

  for (const key of ['q', 'll', 'daddr']) {
    const val = u.searchParams.get(key);
    if (val) {
      const m = val.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
      if (m) return coord(m[1], m[2]);
    }
  }

  return null;
}

function extractPlaceName(url) {
  try {
    // /maps/place/Place+Name/@lat,lng
    const pathMatch = url.match(/\/maps\/place\/([^/@?]+)/);
    if (pathMatch) {
      const name = decodeURIComponent(pathMatch[1].replace(/\+/g, ' ')).split(',')[0].trim();
      if (name) return name;
    }
    // ?q=Place+Name,+Address (iPhone GPS share)
    const u = new URL(url);
    const q = u.searchParams.get('q');
    if (q) {
      const name = decodeURIComponent(q.replace(/\+/g, ' ')).split(',')[0].trim();
      if (name && !/^-?\d/.test(name)) return name; // skip if it's bare coords
    }
  } catch { /* ignore */ }
  return null;
}

function coord(latStr, lngStr) {
  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/* ══════════════════════════════════════════════════════════════
   CLIPBOARD
   ══════════════════════════════════════════════════════════════ */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  flashSuccess();
}

copyBtn.addEventListener('click', () => {
  if (currentLat !== null) copyToClipboard(`${currentLat.toFixed(6)}, ${currentLng.toFixed(6)}`);
});

/* ══════════════════════════════════════════════════════════════
   HISTORY  (localStorage)
   ══════════════════════════════════════════════════════════════ */
function saveToHistory(lat, lng, sourceUrl, placeName) {
  const history = loadHistory();
  const entry   = {
    lat:  lat.toFixed(6),
    lng:  lng.toFixed(6),
    name: placeName || 'Unknown Location',
    date: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };

  if (history.length > 0 && history[0].lat === entry.lat && history[0].lng === entry.lng) return;

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* private mode */ }
  renderHistory();
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function renderHistory() {
  const history = loadHistory();
  historyList.innerHTML = '';

  if (history.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'No rides yet — convert a location to get started.';
    historyList.appendChild(li);
    return;
  }

  history.forEach((entry) => {
    const li = document.createElement('li');
    li.setAttribute('title', 'Click to copy coordinates');
    const displayName = entry.name || entry.source || 'Unknown Location';
    li.innerHTML = `
      <div class="history-name">${escapeHtml(displayName)}</div>
      <div class="history-date">${entry.date}</div>
    `;
    li.addEventListener('click', () => {
      currentLat = parseFloat(entry.lat);
      currentLng = parseFloat(entry.lng);
      showResult(currentLat, currentLng);
      copyToClipboard(`${entry.lat}, ${entry.lng}`);
    });
    historyList.appendChild(li);
  });
}

clearBtn.addEventListener('click', () => {
  if (!confirm('Clear all Recent Rides history?')) return;
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  renderHistory();
});

/* ══════════════════════════════════════════════════════════════
   UI HELPERS
   ══════════════════════════════════════════════════════════════ */
function showResult(lat, lng) {
  latEl.textContent = lat.toFixed(6);
  lngEl.textContent = lng.toFixed(6);
  resultEl.classList.remove('hidden');
}

function hideResult() {
  resultEl.classList.add('hidden');
  successMsg.classList.add('hidden');
}

function flashSuccess() {
  successMsg.classList.remove('hidden');
  setTimeout(() => successMsg.classList.add('hidden'), 3000);
}

function setLoading(state) {
  convertBtn.disabled = state;
  convertBtn.classList.toggle('loading', state);
  convertBtn.textContent = state ? 'Converting…' : 'Convert to GPS';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

function clearError() {
  errorBox.textContent = '';
  errorBox.classList.add('hidden');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
renderHistory();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}
