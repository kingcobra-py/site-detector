# Site Detector

Web app that loads a URL, fetches the live page, and classifies the site into one seller group:

| Group | What it catches |
| --- | --- |
| Gift cards / Video games / Xbox / Apple | Video game shops, CD keys, Apple/Xbox/PlayStation gift cards, in-game top-up |
| eSIM | Travel eSIM and data-plan sellers |
| Clothes | Apparel and fashion stores |
| VPS / Servers | VPS, dedicated servers, hosting |
| Proxies / ISP / Residential | Residential, ISP, mobile, and datacenter proxies |
| Casino / Gambling | Casinos, sportsbooks, betting |
| Donation | Charity and fundraising pages |

## Run

```bash
npm install
npm start
```

Open http://localhost:3000, paste any number of URLs (one per line), and click **Detect all**. The server scans in the background and keeps grouped results on the site, so a 50k list survives refresh.

The server visits the page (so the browser does not hit CORS), reads title, meta description, headings, and body text, then scores keyword signals for each group. Gift-card and video-game detection includes English plus Spanish, French, German, Portuguese, Italian, Turkish, Russian, Arabic, Chinese, Japanese, Korean, and similar phrasing. Accents are folded so `jeux vidéo` still matches.

## Tests

```bash
npm test
```

## Deploy

On a Ubuntu host with Node 20+ and nginx:

1. Copy the repo to `/opt/site-detector` and run `npm ci --omit=dev`.
2. Install `deploy/site-detector.service` as a systemd unit (app listens on `127.0.0.1:3001`).
3. Enable `deploy/nginx-site-detector.conf` so nginx serves the app on port **3000**.
