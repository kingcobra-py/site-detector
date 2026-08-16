import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMany, detectOne } from "./detect.js";
import { normalizeUrl } from "./fetchPage.js";
import { GROUPS, UNKNOWN_GROUP } from "./groups.js";
import {
  createJob,
  getJob,
  getJobItems,
  getJobUrls,
  getLatestJob,
  loadJobsFromDisk,
  stopJob,
} from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(express.text({ type: "text/plain", limit: "40mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/groups", (_req, res) => {
  res.json({ groups: [...GROUPS, UNKNOWN_GROUP] });
});

app.get("/api/jobs/latest", (_req, res) => {
  const job = getLatestJob();
  if (!job) {
    res.status(404).json({ error: "No scan on this server yet" });
    return;
  }
  res.json(job);
});

app.get("/api/jobs/:id/items", (req, res) => {
  const offset = Number(req.query.offset) || 0;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const payload = getJobItems(req.params.id, req.query.group || null, offset, limit);
  if (!payload) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  res.json(payload);
});

app.get("/api/jobs/:id/urls", (req, res) => {
  const text = getJobUrls(req.params.id, req.query.group || null);
  if (text === null) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  res.type("text/plain").send(text);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  res.json(job);
});

app.post("/api/jobs/:id/stop", (req, res) => {
  const job = stopJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  res.json(job);
});

app.post("/api/jobs", async (req, res) => {
  try {
    const body = req.body || {};
    const text = typeof body === "string" ? body : body.text || "";
    const urls = typeof body === "object" ? body.urls : undefined;
    const threads = typeof body === "object" ? body.threads : undefined;
    const job = await createJob({ text, urls, threads });
    res.status(202).json(job);
  } catch (error) {
    res.status(error.code === "EMPTY" ? 400 : 500).json({
      error: error.message || "Could not start scan",
    });
  }
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
      ? "That paste is too large. Split the file or use a .txt list under 40 MB."
      : error.message || "Request failed",
  });
});

await loadJobsFromDisk();
app.listen(PORT, HOST, () => {
  console.log(`Site detector running on http://${HOST}:${PORT}`);
});
