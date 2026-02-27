# ConnectedRide Bridge

A BMW-inspired Progressive Web App (PWA) that converts Google Maps links into GPS coordinates — then launches them directly in your navigation app.

---

## Features

- **Paste & Convert** — paste any Google Maps link (full URL or short `maps.app.goo.gl` link) and extract GPS coordinates instantly
- **Clipboard** — coordinates are automatically copied to your clipboard after conversion
- **Recent Rides** — last 10 converted locations saved locally (no account, no backend)
- **BMW App Launch** — one tap to open coordinates in BMW Connected or your default navigation app
- **Secure API key storage** — key is saved on-device in localStorage only, never in source code
- **Offline ready** — service worker caches the app shell for use without internet
- **Installable** — add to your phone home screen as a full PWA

---

## Supported Google Maps URL Formats

| Format | Example |
|--------|---------|
| Short link | `https://maps.app.goo.gl/UfeFPy4DqWY9HYku7` |
| Place URL | `https://www.google.com/maps/place/Name/@52.3,13.4,15z` |
| Search URL | `https://www.google.com/maps/search/.../@lat,lng,zoom` |
| Query param | `https://maps.google.com/?q=52.3,13.4` |
| `ll` param | `https://maps.google.com/?ll=52.3,13.4` |

---

## Setup

### 1. Clone or download

```bash
git clone https://github.com/your-username/connectedride-bridge.git
cd connectedride-bridge
```

### 2. Add your Google Geocoding API key *(optional)*

Only needed for place-name URLs that don't contain coordinates. Short links and coordinate URLs work without a key.

**The key is never stored in source code.** Set it through the in-app Settings panel instead:

1. Open the app → tap **API Key Settings** (⚙ collapsed card)
2. Paste your key → tap **Save Key**
3. The key is saved to `localStorage` on your device only

To get a key: [Google Cloud Console](https://console.cloud.google.com) → enable the **Geocoding API** → create a credential.

> **Security tip:** After creating the key, restrict it in GCP Console:
> - Application restrictions → **HTTP referrers** → add your app's domain
> - API restrictions → **Geocoding API** only
> - Set a daily quota cap to limit accidental abuse

### 3. Add app icons

Create an `icons/` folder with:
- `icons/icon-192.png` (192×192 px)
- `icons/icon-512.png` (512×512 px)

Quick generator: [pwa-asset-generator](https://github.com/elegantapp/pwa-asset-generator) or [realfavicongenerator.net](https://realfavicongenerator.net)

---

## Running Locally

**Node (recommended):**
```bash
npx serve .
```

**Python:**
```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

> The clipboard API and service worker require HTTPS outside of `localhost`. For full functionality on your phone, deploy to a hosted URL (see below).

---

## Deploying to Your Phone

### Netlify Drop (fastest — 30 seconds)

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the project folder onto the page
3. Copy the generated `https://` URL
4. Open it on your phone → **Add to Home Screen**

### GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/connectedride-bridge.git
git push -u origin main
```

Then in your GitHub repo: **Settings → Pages → Branch: main → Save**

### Vercel

```bash
npx vercel
```

---

## Project Structure

```
connectedride-bridge/
├── index.html       # App shell & layout
├── styles.css       # BMW-inspired design system
├── script.js        # App logic (parsing, API, clipboard, history)
├── manifest.json    # PWA manifest
├── sw.js            # Service worker (cache-first)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## How It Works

```
Paste URL
    │
    ▼
Short URL? (maps.app.goo.gl)
    │  Yes → resolve via CORS proxy → get full URL
    │  No  ↓
    ▼
Extract @lat,lng from URL path / query params
    │
    │  No coords found?
    └──────────────────→ Geocoding API (place name → coords)
    │
    ▼
Display + copy to clipboard + save to Recent Rides
    │
    ▼
"Open BMW App" → geo:lat,lng?q=lat,lng URI scheme
```

---

## Tech Stack

- Vanilla HTML / CSS / JavaScript — zero dependencies
- Google Geocoding API (optional fallback)
- [allorigins.win](https://allorigins.win) CORS proxy (short URL resolution)
- Web APIs: Clipboard API, localStorage, Service Worker, Web App Manifest

---

## License

MIT — free to use and modify.
