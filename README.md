# Site Detector

Web app that loads a URL, fetches the live page, and classifies the site into one seller group:

| Group | What it catches |
| --- | --- |
| Gift cards / Games / CD keys / Top-up | Gift card shops, game key stores, CD keys, in-game top-up |
| eSIM | Travel eSIM and data-plan sellers |
| Clothes | Apparel and fashion stores |
| VPS / Servers | VPS, dedicated servers, hosting |
| Casino / Gambling | Casinos, sportsbooks, betting |
| Donation | Charity and fundraising pages |

## Run

```bash
npm install
npm start
```

Open http://localhost:3000, paste any number of URLs (one per line), and click **Detect all**. Results are shown in seller groups as each batch finishes.

The server visits the page (so the browser does not hit CORS), reads title, meta description, headings, and body text, then scores keyword signals for each group.

## Tests

```bash
npm test
```

## Deploy

On a Ubuntu host with Node 20+ and nginx:

1. Copy the repo to `/opt/site-detector` and run `npm ci --omit=dev`.
2. Install `deploy/site-detector.service` as a systemd unit (app listens on `127.0.0.1:3001`).
3. Enable `deploy/nginx-site-detector.conf` so nginx serves the app on port **3000**.
