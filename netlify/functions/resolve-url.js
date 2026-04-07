/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — Netlify Function: resolve-url
   Manually follows every redirect hop using Node's https module,
   checking each URL for coordinates before reading any HTML.
   ══════════════════════════════════════════════════════════════ */

const https = require('https');
const http  = require('http');

const HEADERS = {
  // Desktop UA — mobile UAs cause Google to redirect to app-store/universal links
  // with no embedded coordinates, forcing a geocoding fallback.
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

exports.handler = async (event) => {
  const resHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, headers: resHeaders, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }
  if (!/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
    return { statusCode: 400, headers: resHeaders, body: JSON.stringify({ error: 'Only Google Maps short URLs are supported' }) };
  }

  try {
    const result = await smartResolve(url);

    let { lat, lng } = result;

    // If no coords found in URL/HTML, try geocoding cascade on the ?q= address
    if (lat === null || lng === null) {
      try {
        const u = new URL(result.finalUrl);
        const q = u.searchParams.get('q');
        if (q) {
          const geo = await geocodeCascade(q);
          if (geo) { lat = geo.lat; lng = geo.lng; }
        }
      } catch { /* ignore */ }
    }

    console.log('[resolve-url]', JSON.stringify({
      input: url, finalUrl: result.finalUrl, lat, lng, hops: result.hops,
    }));

    return {
      statusCode: 200,
      headers: resHeaders,
      body: JSON.stringify({ finalUrl: result.finalUrl, lat, lng }),
    };
  } catch (err) {
    console.error('[resolve-url] error:', err.message);
    return { statusCode: 500, headers: resHeaders, body: JSON.stringify({ error: err.message }) };
  }
};

/* ── Core resolver ───────────────────────────────────────────── */
async function smartResolve(startUrl) {
  let current = startUrl;
  const hops  = [];

  for (let i = 0; i < 8; i++) {
    const { status, location, html } = await makeRequest(current);
    hops.push({ url: current.substring(0, 120), status });

    // Always check the current URL first
    let coords = extractCoordsFromUrl(current);
    if (coords) return { finalUrl: current, ...coords, hops };

    if (status >= 300 && status < 400 && location) {
      // Resolve relative redirects
      const next = location.startsWith('http')
        ? location
        : new URL(location, current).href;

      // Check the redirect target URL for coords BEFORE following
      coords = extractCoordsFromUrl(next);
      if (coords) return { finalUrl: next, ...coords, hops };

      current = next;
      continue;
    }

    // Final page — parse HTML
    coords = extractCoordsFromHtml(html);
    return {
      finalUrl: current,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      hops,
    };
  }

  return { finalUrl: current, lat: null, lng: null, hops };
}

/* ── Raw HTTP request (manual redirect, no auto-follow) ─────── */
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }

    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  HEADERS,
    };

    const req = lib.request(options, (res) => {
      const { statusCode: status, headers } = res;
      const location = headers.location || null;

      if (status >= 300 && status < 400) {
        res.resume(); // drain so socket can be reused
        return resolve({ status, location, html: '' });
      }

      // Read HTML up to 200 KB — enough to find any embedded coord
      let html = '';
      res.on('data', (chunk) => {
        if (html.length < 200000) html += chunk.toString();
      });
      res.on('end',   () => resolve({ status, location, html }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out for: ' + url)); });
    req.end();
  });
}

/* ── Coord extraction ────────────────────────────────────────── */
function validCoord(lat, lng) {
  lat = parseFloat(lat);
  lng = parseFloat(lng);
  if (isNaN(lat) || isNaN(lng))           return null;
  if (lat < -90  || lat > 90)             return null;
  if (lng < -180 || lng > 180)            return null;
  return { lat, lng };
}

function extractCoordsFromUrl(url) {
  // !3d{lat}!4d{lng} is the actual place pin — check before viewport @lat,lng
  const d = url.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (d) return validCoord(d[1], d[2]);

  // @lat,lng  (viewport center — fallback only)
  const at = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (at) return validCoord(at[1], at[2]);

  // ?q=lat,lng
  try {
    const u = new URL(url);
    const q = u.searchParams.get('q');
    if (q) {
      const m = q.match(/^(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)$/);
      if (m) return validCoord(m[1], m[2]);
    }
  } catch { /* ignore */ }

  return null;
}

/* ── Geocoding cascade — tries multiple strategies & services ── */
async function geocodeCascade(rawAddress) {
  // Normalise: decode URL-encoded chars, collapse whitespace
  const address = decodeURIComponent(rawAddress).replace(/\+/g, ' ').trim();
  const placeName = address.split(',')[0].trim();

  // ── Strategy 1: Google Geocoding API (most accurate) ─────────
  const googleKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (googleKey) {
    let result = await geocodeGoogle(address, googleKey);
    if (result) return result;
    // Retry with ", Malaysia" appended if not already present
    if (!address.toLowerCase().includes('malaysia')) {
      result = await geocodeGoogle(address + ', Malaysia', googleKey);
      if (result) return result;
    }
  }

  // ── Strategy 2: Nominatim — full address ─────────────────────
  let result = await geocodeNominatim(address);
  if (result) return result;

  // ── Strategy 3: Nominatim — full address + ", Malaysia" ──────
  if (!address.toLowerCase().includes('malaysia')) {
    result = await geocodeNominatim(address + ', Malaysia');
    if (result) return result;
  }

  // ── Strategy 4: Nominatim — simplified (name + postcode) ─────
  const postcodeMatch = address.match(/\b(\d{5})\b/);
  if (postcodeMatch && placeName) {
    result = await geocodeNominatim(`${placeName}, ${postcodeMatch[1]}, Malaysia`);
    if (result) return result;

    result = await geocodeNominatim(`${postcodeMatch[1]}, Malaysia`);
    if (result) return result;
  }

  // ── Strategy 5: Photon (komoot) — full address ───────────────
  result = await geocodePhoton(address);
  if (result) return result;

  // ── Strategy 6: Photon — place name only ─────────────────────
  if (placeName && placeName !== address) {
    result = await geocodePhoton(placeName + ' Malaysia');
    if (result) return result;
  }

  return null;
}

/* ── Google Geocoding API ────────────────────────────────────── */
async function geocodeGoogle(query, apiKey) {
  try {
    const endpoint =
      `https://maps.googleapis.com/maps/api/geocode/json` +
      `?address=${encodeURIComponent(query)}&key=${apiKey}`;

    const res = await fetch(endpoint, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) return null;

    const { lat, lng } = data.results[0].geometry.location;
    console.log('[resolve-url] Google Geocoding hit:', query, '->', lat, lng);
    return validCoord(lat, lng);
  } catch {
    return null;
  }
}

/* ── Nominatim geocoder (OpenStreetMap) — no API key needed ─── */
async function geocodeNominatim(query) {
  try {
    const endpoint =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0` +
      `&countrycodes=my`;  // Malaysia only — prevents cross-continent false matches

    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': 'ConnectedRideBridge/1.0',
        'Accept':     'application/json',
      },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    console.log('[resolve-url] Nominatim hit:', query, '->', data[0].lat, data[0].lon);
    return validCoord(data[0].lat, data[0].lon);
  } catch {
    return null;
  }
}

/* ── Photon geocoder (komoot) — no API key needed ───────────── */
async function geocodePhoton(query) {
  try {
    const endpoint =
      `https://photon.komoot.io/api/` +
      `?q=${encodeURIComponent(query)}&limit=1`;

    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': 'ConnectedRideBridge/1.0',
        'Accept':     'application/json',
      },
    });

    if (!res.ok) return null;
    const data = await res.json();
    const feat = data?.features?.[0];
    if (!feat) return null;
    const [lng, lat] = feat.geometry?.coordinates ?? [];
    // Reject if outside Malaysia's bounding box (prevents cross-continent returns)
    if (lat < 0.8 || lat > 8.0 || lng < 99.0 || lng > 119.5) return null;
    console.log('[resolve-url] Photon hit:', query, '->', lat, lng);
    return validCoord(lat, lng);
  } catch {
    return null;
  }
}

function extractCoordsFromHtml(html) {
  if (!html) return null;

  // !3d{lat}!4d{lng} embedded anywhere in page source (most reliable)
  const d = html.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (d) return validCoord(d[1], d[2]);

  // og:url and canonical often contain the full Maps URL with !3d!4d or @lat,lng
  const ogUrl =
    html.match(/property="og:url"\s+content="([^"]+)"/)?.[1] ||
    html.match(/content="([^"]+)"\s+property="og:url"/)?.[1];
  if (ogUrl) {
    const c = extractCoordsFromUrl(ogUrl.replace(/&amp;/g, '&'));
    if (c) return c;
  }
  const canonical =
    html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1] ||
    html.match(/href="([^"]+)"\s+rel="canonical"/)?.[1];
  if (canonical) {
    const c = extractCoordsFromUrl(canonical.replace(/&amp;/g, '&'));
    if (c) return c;
  }

  // itemprop latitude / longitude
  const latM = html.match(/itemprop="latitude"[^>]*content="(-?\d{1,3}\.\d+)"/);
  const lngM = html.match(/itemprop="longitude"[^>]*content="(-?\d{1,3}\.\d+)"/);
  if (latM && lngM) return validCoord(latM[1], lngM[1]);

  // JSON-LD "latitude": 52.1, "longitude": 13.4
  const jld = html.match(/"latitude"\s*:\s*(-?\d{1,3}\.\d+)[\s\S]{0,40}"longitude"\s*:\s*(-?\d{1,3}\.\d+)/);
  if (jld) return validCoord(jld[1], jld[2]);

  // "lat":52.123,"lng":13.456  (Maps JS init)
  const ll = html.match(/"lat"\s*:\s*(-?\d{1,3}\.\d+)\s*,\s*"lng"\s*:\s*(-?\d{1,3}\.\d+)/);
  if (ll) return validCoord(ll[1], ll[2]);

  // @lat,lng with ≥5 decimal places anchored inside a URL href/content — avoid matching raw JS numbers
  const at = html.match(/(?:href|content)="[^"]*@(-?\d{1,3}\.\d{5,}),(-?\d{1,3}\.\d{5,})/);
  if (at) return validCoord(at[1], at[2]);

  return null;
}
