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

Open http://localhost:3000, paste a URL, and click **Detect**.

The server visits the page (so the browser does not hit CORS), reads title, meta description, headings, and body text, then scores keyword signals for each group.

## Tests

```bash
npm test
```
