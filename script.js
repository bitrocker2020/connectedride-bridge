/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — script.js
   ══════════════════════════════════════════════════════════════

   To enable Geocoding fallback for short/place-name URLs:
   1. Get a key at https://developers.google.com/maps/documentation/geocoding/get-api-key
   2. Replace the placeholder below with your actual key.
   3. Restrict the key to the Geocoding API in the GCP console.
   ══════════════════════════════════════════════════════════════ */

// API key is NEVER stored in source code.
// It lives only in the user's localStorage on their own device.
const API_KEY_STORAGE = 'cr_api_key';
const HISTORY_KEY     = 'cr_bridge_history';
const MAX_HISTORY     = 10;

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

/* ── DOM refs ────────────────────────────────────────────────── */
const mapsInput         = document.getElementById('mapsInput');
const pasteBtn          = document.getElementById('pasteBtn');
const convertBtn        = document.getElementById('convertBtn');
const errorBox          = document.getElementById('errorMsg');
const resultEl          = document.getElementById('result');
const latEl             = document.getElementById('lat');
const lngEl             = document.getElementById('lng');
const successMsg        = document.getElementById('successMsg');
const copyBtn           = document.getElementById('copyBtn');
const bmwBtn            = document.getElementById('bmwBtn');
const historyList       = document.getElementById('historyList');
const clearBtn          = document.getElementById('clearBtn');

// Settings
const settingsToggle      = document.getElementById('settingsToggle');
const settingsBody        = document.getElementById('settingsBody');
const apiKeyInput         = document.getElementById('apiKeyInput');
const toggleKeyVisibility = document.getElementById('toggleKeyVisibility');
const saveKeyBtn          = document.getElementById('saveKeyBtn');
const clearKeyBtn         = document.getElementById('clearKeyBtn');
const keyStatus           = document.getElementById('keyStatus');

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

mapsInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleConvert();
});

async function handleConvert() {
  const raw = mapsInput.value.trim();
  if (!raw) {
    showError('Please paste a Google Maps link first.');
    return;
  }
  await convertLink(raw);
}

async function convertLink(url) {
  setLoading(true);
  clearError();
  hideResult();

  try {
    // Step 1: expand short URLs (maps.app.goo.gl, goo.gl/maps) via CORS proxy
    let resolvedUrl = url;
    if (isShortUrl(url)) {
      resolvedUrl = await resolveShortUrl(url);
    }

    // Step 2: try to extract coords directly from the resolved URL (no API needed)
    let coords = extractCoordsFromUrl(resolvedUrl);

    // Step 3: fall back to Geocoding API for place-name URLs
    if (!coords) {
      coords = await geocodeViaApi(resolvedUrl);
    }

    if (coords) {
      currentLat = coords.lat;
      currentLng = coords.lng;
      showResult(coords.lat, coords.lng);
      await copyToClipboard(`${coords.lat}, ${coords.lng}`);
      saveToHistory(coords.lat, coords.lng, url);
    } else {
      showError('Could not extract coordinates. Try using the full Google Maps URL (not a shortened link).');
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/* ══════════════════════════════════════════════════════════════
   SHORT URL RESOLUTION
   maps.app.goo.gl and goo.gl/maps are redirects — the coordinates
   only appear in the final expanded URL. We follow the redirect via
   the allorigins.win CORS proxy which returns status.url (final URL).
   ══════════════════════════════════════════════════════════════ */
function isShortUrl(url) {
  return /maps\.app\.goo\.gl|goo\.gl\/maps/.test(url);
}

async function resolveShortUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res  = await fetch(proxyUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`Proxy error ${res.status}`);
    const data = await res.json();
    const finalUrl = data.status?.url;
    if (!finalUrl) throw new Error('Proxy did not return a final URL.');
    return finalUrl;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out resolving short URL — check your connection.');
    throw new Error(`Could not expand short link: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

/* ══════════════════════════════════════════════════════════════
   URL PARSING  (no API key required)
   ══════════════════════════════════════════════════════════════

   Handles these Google Maps URL formats:
   ① /maps/place/Name/@lat,lng,zoom      → @-coord extraction
   ② /maps/search/query/@lat,lng,zoom    → @-coord extraction
   ③ /maps?q=lat,lng                     → query-param extraction
   ④ maps.google.com/?ll=lat,lng         → ll-param extraction
   ⑤ maps.google.com/?daddr=lat,lng      → daddr-param extraction
   ══════════════════════════════════════════════════════════════ */
function extractCoordsFromUrl(url) {
  // ① ② @lat,lng anywhere in the path
  const atMatch = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) {
    return coord(atMatch[1], atMatch[2]);
  }

  // Try URL params
  let u;
  try { u = new URL(url); } catch { return null; }

  // ③ ?q=lat,lng
  const q = u.searchParams.get('q');
  if (q) {
    const m = q.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
    if (m) return coord(m[1], m[2]);
  }

  // ④ ?ll=lat,lng
  const ll = u.searchParams.get('ll');
  if (ll) {
    const m = ll.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
    if (m) return coord(m[1], m[2]);
  }

  // ⑤ ?daddr=lat,lng  (directions destination)
  const daddr = u.searchParams.get('daddr');
  if (daddr) {
    const m = daddr.match(/^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/);
    if (m) return coord(m[1], m[2]);
  }

  return null;
}

function coord(latStr, lngStr) {
  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  // Basic sanity-check
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/* ══════════════════════════════════════════════════════════════
   GEOCODING API FALLBACK
   ══════════════════════════════════════════════════════════════ */
async function geocodeViaApi(url) {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      'No API key saved. Open Settings above and paste your Google Geocoding API key to support place-name URLs.'
    );
  }

  // Extract a place query from the URL path or params
  let query = '';
  try {
    const u = new URL(url);
    const q = u.searchParams.get('q');
    if (q) {
      query = q;
    } else {
      // /maps/place/Place+Name/@...  or  /maps/search/Place+Name
      const pathMatch = u.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/);
      if (pathMatch) {
        query = decodeURIComponent(pathMatch[1].replace(/\+/g, ' '));
      }
    }
  } catch {
    query = url; // last resort: geocode the raw string
  }

  if (!query) {
    throw new Error('Cannot determine a place name from this URL to geocode.');
  }

  const endpoint =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?address=${encodeURIComponent(query)}&key=${key}`;

  const res  = await fetch(endpoint);
  const data = await res.json();

  if (data.status === 'OK' && data.results.length > 0) {
    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  }

  const msg = {
    ZERO_RESULTS:      'No results found for that place name.',
    REQUEST_DENIED:    'Geocoding API request denied — check your API key.',
    OVER_QUERY_LIMIT:  'API quota exceeded — try again later.',
    INVALID_REQUEST:   'Invalid API request.',
  }[data.status] || `Geocoding failed (${data.status}).`;

  throw new Error(msg);
}

/* ══════════════════════════════════════════════════════════════
   CLIPBOARD
   ══════════════════════════════════════════════════════════════ */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for browsers/contexts that block clipboard API
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
  if (currentLat !== null) {
    copyToClipboard(`${currentLat.toFixed(6)}, ${currentLng.toFixed(6)}`);
  }
});

/* ══════════════════════════════════════════════════════════════
   BMW APP LAUNCH
   Uses the standard geo: URI scheme (opens BMW Connected, Google
   Maps, or the system default navigation app on Android/iOS).
   ══════════════════════════════════════════════════════════════ */
bmwBtn.addEventListener('click', () => {
  if (currentLat === null) return;
  const lat = currentLat.toFixed(6);
  const lng = currentLng.toFixed(6);
  window.location.href = `geo:${lat},${lng}?q=${lat},${lng}`;
});

/* ══════════════════════════════════════════════════════════════
   HISTORY  (localStorage)
   ══════════════════════════════════════════════════════════════ */
function saveToHistory(lat, lng, sourceUrl) {
  const history = loadHistory();

  // Truncate source URL for display
  const maxLen = 48;
  const source = sourceUrl.length > maxLen
    ? sourceUrl.slice(0, maxLen) + '…'
    : sourceUrl;

  const entry = {
    lat:    lat.toFixed(6),
    lng:    lng.toFixed(6),
    source,
    date:   new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  };

  // Avoid duplicate consecutive entries
  if (history.length > 0 && history[0].lat === entry.lat && history[0].lng === entry.lng) {
    return;
  }

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // localStorage unavailable (private mode, etc.) — silently skip
  }

  renderHistory();
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
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
    li.setAttribute('title', 'Click to reload these coordinates');
    li.innerHTML = `
      <div>
        <div class="history-coords">${entry.lat}, ${entry.lng}</div>
        <div class="history-source">${escapeHtml(entry.source)}</div>
      </div>
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
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS — API KEY
   Key lives in localStorage only. Never in source code.
   ══════════════════════════════════════════════════════════════ */
function updateKeyStatus() {
  const saved = !!getApiKey();
  keyStatus.textContent       = saved ? 'Key saved' : 'Not set';
  keyStatus.className         = `key-status ${saved ? 'key-status--saved' : 'key-status--missing'}`;
  if (saved) {
    // Pre-fill input with masked placeholder so user knows a key exists
    apiKeyInput.value       = '';
    apiKeyInput.placeholder = '••••••••••••••••••••';
  } else {
    apiKeyInput.placeholder = 'AIza...';
  }
}

// Collapse / expand
settingsToggle.addEventListener('click', () => {
  const isOpen = settingsToggle.getAttribute('aria-expanded') === 'true';
  settingsToggle.setAttribute('aria-expanded', String(!isOpen));
  settingsBody.classList.toggle('hidden', isOpen);
});

// Show / hide key
toggleKeyVisibility.addEventListener('click', () => {
  const isPassword = apiKeyInput.type === 'password';
  apiKeyInput.type              = isPassword ? 'text' : 'password';
  toggleKeyVisibility.textContent = isPassword ? 'Hide' : 'Show';
});

// Save
saveKeyBtn.addEventListener('click', () => {
  const val = apiKeyInput.value.trim();
  if (!val) {
    alert('Please paste your API key first.');
    return;
  }
  if (!val.startsWith('AIza') || val.length < 30) {
    alert('That doesn\'t look like a valid Google API key (should start with "AIza").');
    return;
  }
  localStorage.setItem(API_KEY_STORAGE, val);
  apiKeyInput.value = '';
  apiKeyInput.type  = 'password';
  toggleKeyVisibility.textContent = 'Show';
  updateKeyStatus();
  // Collapse panel after saving
  settingsToggle.setAttribute('aria-expanded', 'false');
  settingsBody.classList.add('hidden');
});

// Remove
clearKeyBtn.addEventListener('click', () => {
  if (!confirm('Remove your saved API key from this device?')) return;
  localStorage.removeItem(API_KEY_STORAGE);
  apiKeyInput.value = '';
  updateKeyStatus();
});

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
updateKeyStatus();
renderHistory();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}
