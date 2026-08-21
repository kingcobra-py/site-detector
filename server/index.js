import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectMany, detectOne } from "./detect.js";
import { normalizeUrl } from "./fetchPage.js";
import { canScreenshotGroup, captureScreenshot } from "./screenshot.js";
import { GROUPS, UNKNOWN_GROUP } from "./groups.js";
import {
  clearFailed,
  createJob,
  resumeJob,
  findJobItemByUrl,
  getJob,
  getJobItems,
  getJobUrls,
  getLatestJob,
  loadJobsFromDisk,
  resumeIncompleteJobs,
  stopJob,
} from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const BODY_LIMIT = "250mb";

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.text({ type: "text/plain", limit: BODY_LIMIT }));
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

app.get("/api/jobs/:id/screenshot", async (req, res) => {
  const url = String(req.query.url || "");
  const { job, item } = findJobItemByUrl(req.params.id, url);
  if (!job) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  if (!item || !canScreenshotGroup(item.groupId)) {
    res.status(400).json({ error: "Screenshots are only for grouped matches, not unknown or failed URLs." });
    return;
  }
  try {
    const file = await captureScreenshot(item.finalUrl || item.requestedUrl);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/jpeg").sendFile(file);
  } catch (error) {
    res.status(502).json({ error: error.message || "Could not capture that screenshot" });
  }
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

app.post("/api/jobs/:id/clear-failed", async (req, res) => {
  const job = await clearFailed(req.params.id);
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

app.post("/api/jobs/:id/resume", (req, res) => {
  const job = resumeJob(req.params.id);
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
    const urls = typeof body === "object" && !Array.isArray(body) ? body.urls : undefined;
    const threads =
      req.query.threads ??
      (typeof body === "object" && body && !Array.isArray(body) ? body.threads : undefined);
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
      ? "That list is too large. Upload a .txt file under 250 MB, or split the list."
      : error.message || "Request failed",
  });
});

await loadJobsFromDisk();
const resumed = resumeIncompleteJobs();
if (resumed.length) {
  console.log(`Resumed ${resumed.length} unfinished scan(s)`);
}
app.listen(PORT, HOST, () => {
  console.log(`Site detector running on http://${HOST}:${PORT}`);
});
