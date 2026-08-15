import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPage } from "./classify.js";
import { fetchPage, normalizeUrl } from "./fetchPage.js";
import { GROUPS, UNKNOWN_GROUP } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/groups", (_req, res) => {
  res.json({ groups: [...GROUPS, UNKNOWN_GROUP] });
});

app.post("/api/detect", async (req, res) => {
  const input = req.body?.url;
  try {
    normalizeUrl(input);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  try {
    const page = await fetchPage(input);
    const result = classifyPage({ html: page.html, url: page.url });
    res.json({
      requestedUrl: page.requestedUrl,
      finalUrl: page.url,
      status: page.status,
      title: result.title,
      description: result.description,
      hostname: result.hostname,
      group: result.group,
      confidence: result.confidence,
      scores: result.scores,
      ranked: result.ranked,
      matches: result.matches,
    });
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not analyze that site" });
  }
});

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Site detector running on http://localhost:${PORT}`);
});
