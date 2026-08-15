import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMany, detectOne } from "./detect.js";
import { normalizeUrl } from "./fetchPage.js";
import { GROUPS, UNKNOWN_GROUP } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(express.json({ limit: "10mb" }));
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
    res.json(await detectOne(input));
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not analyze that site" });
  }
});

app.post("/api/detect-bulk", async (req, res) => {
  const input = req.body?.urls ?? req.body?.text ?? req.body?.url;
  try {
    res.json(await detectMany(input));
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not analyze those sites" });
  }
});

app.all("/api/{*path}", (_req, res) => {
  res.status(404).json({ error: "Unknown API route" });
});

app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const tooLarge = error?.type === "entity.too.large" || error?.status === 413;
  res.status(tooLarge ? 413 : error.status || 500).json({
    error: tooLarge
      ? "That paste is too large for one request. The page will send URLs in batches — try Detect all again."
      : error.message || "Request failed",
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Site detector running on http://${HOST}:${PORT}`);
});
