/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — Netlify Function: resolve-url
   Follows a Google Maps short URL redirect server-side and returns
   the final expanded URL. No CORS issues, no third-party proxies.

   Endpoint: /.netlify/functions/resolve-url?url=<encoded-short-url>
   ══════════════════════════════════════════════════════════════ */

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const url = event.queryStringParameters?.url;

  if (!url) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing url parameter' }),
    };
  }

  // Only allow Google Maps short URLs
  if (!/maps\.app\.goo\.gl|goo\.gl\/maps/.test(url)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Only Google Maps short URLs are supported' }),
    };
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ finalUrl: res.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
