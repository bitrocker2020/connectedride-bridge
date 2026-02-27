/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — Netlify Function: resolve-url
   Manually follows every redirect hop using Node's https module,
   checking each URL for coordinates before reading any HTML.
   ══════════════════════════════════════════════════════════════ */

const https = require('https');
const http  = require('http');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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
    // Log for Netlify function dashboard debugging
    console.log('[resolve-url]', JSON.stringify({
      input: url,
      finalUrl: result.finalUrl,
      lat: result.lat,
      lng: result.lng,
      hops: result.hops,
    }));

    return {
      statusCode: 200,
      headers: resHeaders,
      body: JSON.stringify({
        finalUrl: result.finalUrl,
        lat: result.lat,
        lng: result.lng,
      }),
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
  // @lat,lng  (viewport coords)
  const at = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (at) return validCoord(at[1], at[2]);

  // !3d{lat}!4d{lng}  (place data blob)
  const d = url.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (d) return validCoord(d[1], d[2]);

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

function extractCoordsFromHtml(html) {
  if (!html) return null;

  // !3d{lat}!4d{lng} embedded in page source
  const d = html.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (d) return validCoord(d[1], d[2]);

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

  // @lat,lng with ≥5 decimal places (precise enough to be real)
  const at = html.match(/@(-?\d{1,3}\.\d{5,}),(-?\d{1,3}\.\d{5,})/);
  if (at) return validCoord(at[1], at[2]);

  return null;
}
