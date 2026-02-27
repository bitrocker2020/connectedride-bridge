/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — Netlify Function: resolve-url
   Follows a Google Maps short URL server-side, then extracts
   GPS coordinates from the final URL and/or the page HTML.

   Response: { finalUrl, lat, lng }  — lat/lng null if not found
   ══════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const url = event.queryStringParameters?.url;

  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }

  if (!/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only Google Maps short URLs are supported' }) };
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
          'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    const finalUrl = res.url;
    const html = await res.text();

    // Try URL first (fast), then fall back to parsing HTML
    const coords = extractCoordsFromUrl(finalUrl) || extractCoordsFromHtml(html);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        finalUrl,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

/* ── Coord helpers ───────────────────────────────────────────── */
function validCoord(lat, lng) {
  lat = parseFloat(lat);
  lng = parseFloat(lng);
  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function extractCoordsFromUrl(url) {
  // @lat,lng (standard Maps viewport)
  const at = url.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (at) return validCoord(at[1], at[2]);

  // !3d{lat}!4d{lng} inside data= parameter
  const data = url.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (data) return validCoord(data[1], data[2]);

  return null;
}

function extractCoordsFromHtml(html) {
  if (!html) return null;

  // !3d{lat}!4d{lng} embedded in page HTML (data params, canonical links)
  const data = html.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (data) return validCoord(data[1], data[2]);

  // itemprop="latitude" / itemprop="longitude"
  const latMeta = html.match(/itemprop="latitude"[^>]*content="(-?\d{1,3}\.\d+)"/);
  const lngMeta = html.match(/itemprop="longitude"[^>]*content="(-?\d{1,3}\.\d+)"/);
  if (latMeta && lngMeta) return validCoord(latMeta[1], lngMeta[1]);

  // JSON-LD GeoCoordinates: "latitude":52.123,"longitude":13.456
  const jsonGeo = html.match(/"latitude"\s*:\s*(-?\d{1,3}\.\d+)[\s\S]{0,30}?"longitude"\s*:\s*(-?\d{1,3}\.\d+)/);
  if (jsonGeo) return validCoord(jsonGeo[1], jsonGeo[2]);

  // "lat":52.123,"lng":13.456 (common in Maps JS init data)
  const latLng = html.match(/"lat"\s*:\s*(-?\d{1,3}\.\d+)\s*,\s*"lng"\s*:\s*(-?\d{1,3}\.\d+)/);
  if (latLng) return validCoord(latLng[1], latLng[2]);

  // @lat,lng with enough decimal places to be real coordinates (not zoom levels)
  const at = html.match(/@(-?\d{1,3}\.\d{5,}),(-?\d{1,3}\.\d{5,})/);
  if (at) return validCoord(at[1], at[2]);

  return null;
}
