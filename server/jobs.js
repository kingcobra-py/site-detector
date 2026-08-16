import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectOne, parseUrlList } from "./detect.js";
import { GROUPS, UNKNOWN_GROUP } from "./groups.js";

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "../data");

const jobs = new Map();
let activeJobId = null;

function emptyCounts() {
  return Object.fromEntries([...GROUPS, UNKNOWN_GROUP].map((group) => [group.id, 0]));
}

function jobDir(id) {
  return path.join(DATA_DIR, id);
}

function slimItem(result) {
  return {
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    title: result.title,
    hostname: result.hostname,
    confidence: result.confidence,
    groupId: result.group?.id || "unknown",
    groupLabel: result.group?.label || UNKNOWN_GROUP.label,
  };
}

function publicJob(job, { includeItems = false } = {}) {
  const groups = [...GROUPS, UNKNOWN_GROUP].map((group) => ({
    ...group,
    count: job.counts[group.id] || 0,
    items: includeItems ? job.items.filter((item) => item.groupId === group.id) : [],
  }));
  return {
    id: job.id,
    status: job.status,
    queued: job.total,
    processed: job.ok + job.failed,
    ok: job.ok,
    failed: job.failed,
    threads: job.threads,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    counts: job.counts,
    groups,
    errorCount: job.errors.length,
  };
}

async function persistMeta(job) {
  await mkdir(jobDir(job.id), { recursive: true });
  const meta = {
    id: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    ok: job.ok,
    failed: job.failed,
    threads: job.threads,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    counts: job.counts,
    cursor: job.cursor,
  };
  await writeFile(path.join(jobDir(job.id), "meta.json"), JSON.stringify(meta));
  await writeFile(path.join(DATA_DIR, "latest"), job.id);
}

async function persistUrls(job) {
  await mkdir(jobDir(job.id), { recursive: true });
  await writeFile(path.join(jobDir(job.id), "urls.json"), JSON.stringify(job.urls));
}

async function persistItem(job, item) {
  await appendFile(path.join(jobDir(job.id), "items.jsonl"), `${JSON.stringify(item)}\n`);
}

async function persistError(job, error) {
  await appendFile(path.join(jobDir(job.id), "errors.jsonl"), `${JSON.stringify(error)}\n`);
}

async function readJsonl(file) {
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function loadJobsFromDisk() {
  await mkdir(DATA_DIR, { recursive: true });
  let ids = [];
  try {
    ids = (await readdir(DATA_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }

  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(path.join(jobDir(id), "meta.json"), "utf8"));
      let urls = meta.urls || [];
      try {
        urls = JSON.parse(await readFile(path.join(jobDir(id), "urls.json"), "utf8"));
      } catch {
        urls = meta.urls || [];
      }
      const items = await readJsonl(path.join(jobDir(id), "items.jsonl"));
      const errors = await readJsonl(path.join(jobDir(id), "errors.jsonl"));
      const job = {
        ...meta,
        urls,
        items,
        errors,
        counts: meta.counts || emptyCounts(),
        cursor: meta.cursor || items.length + errors.length,
        stopRequested: false,
      };
      if (job.status === "running") job.status = "stopped";
      jobs.set(id, job);
    } catch {
      // skip broken job folders
    }
  }
}

export function getLatestJob() {
  if (activeJobId && jobs.has(activeJobId)) return publicJob(jobs.get(activeJobId));
  const all = [...jobs.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return all[0] ? publicJob(all[0]) : null;
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function getJobItems(id, groupId, offset = 0, limit = 200) {
  const job = jobs.get(id);
  if (!job) return null;
  const items = groupId ? job.items.filter((item) => item.groupId === groupId) : job.items;
  const errors = groupId ? [] : job.errors;
  return {
    id: job.id,
    groupId: groupId || null,
    total: items.length,
    offset,
    items: items.slice(offset, offset + limit),
    errors: groupId ? [] : errors.slice(offset, offset + limit),
    errorTotal: errors.length,
  };
}

export function getJobUrls(id, groupId) {
  const job = jobs.get(id);
  if (!job) return null;
  if (groupId === "errors") {
    return job.errors.map((item) => item.url).join("\n");
  }
  return job.items
    .filter((item) => !groupId || item.groupId === groupId)
    .map((item) => item.finalUrl || item.requestedUrl)
    .join("\n");
}

export function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.stopRequested = true;
  if (job.status === "running") job.status = "stopping";
  job.updatedAt = Date.now();
  persistMeta(job).catch(() => {});
  return publicJob(job);
}

async function runJob(job) {
  activeJobId = job.id;
  job.status = "running";
  job.updatedAt = Date.now();
  await persistMeta(job);

  const threads = Math.max(1, job.threads || 8);
  let next = job.cursor || 0;

  async function worker() {
    while (true) {
      if (job.stopRequested) return;
      const index = next;
      next += 1;
      if (index >= job.urls.length) return;
      const url = job.urls[index];
      try {
        const result = slimItem(await detectOne(url));
        job.items.push(result);
        job.ok += 1;
        job.counts[result.groupId] = (job.counts[result.groupId] || 0) + 1;
        await persistItem(job, result);
      } catch (error) {
        const failed = { url, error: error.message || "Could not analyze that site" };
        job.errors.push(failed);
        job.failed += 1;
        await persistError(job, failed);
      }
      job.processed += 1;
      job.cursor = Math.max(job.cursor, index + 1);
      job.updatedAt = Date.now();
      if (job.processed % 25 === 0) await persistMeta(job);
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(threads, job.urls.length) }, worker));
    job.status = job.stopRequested ? "stopped" : "done";
  } catch (error) {
    job.status = "error";
    job.error = error.message;
  }
  job.updatedAt = Date.now();
  await persistMeta(job);
  if (activeJobId === job.id) activeJobId = job.status === "running" ? job.id : job.id;
}

export function resolveThreads(requested, urlCount) {
  const count = Math.max(1, urlCount || 1);
  if (requested === 0 || requested === "unlimited" || requested === "0") return count;
  const n = Number(requested);
  if (!Number.isFinite(n) || n < 1) return Math.min(8, count);
  return Math.max(1, Math.round(n));
}

export async function createJob({ text, urls, threads = 8 }) {
  const parsed = parseUrlList(urls || text);
  const allUrls = parsed.urls;
  if (!allUrls.length && !parsed.invalid.length) {
    const error = new Error("Paste at least one URL.");
    error.code = "EMPTY";
    throw error;
  }

  for (const job of jobs.values()) {
    if (job.status === "running") {
      job.stopRequested = true;
      job.status = "stopped";
    }
  }

  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    status: "queued",
    urls: allUrls,
    items: [],
    errors: parsed.invalid.map((item) => ({ url: item.url, error: item.error })),
    counts: emptyCounts(),
    total: allUrls.length + parsed.invalid.length,
    processed: parsed.invalid.length,
    ok: 0,
    failed: parsed.invalid.length,
    threads: resolveThreads(threads, allUrls.length),
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    stopRequested: false,
  };
  jobs.set(id, job);
  await persistUrls(job);
  await persistMeta(job);
  for (const failed of job.errors) await persistError(job, failed);
  runJob(job).catch((error) => {
    job.status = "error";
    job.error = error.message;
  });
  return publicJob(job);
}

export { publicJob, DATA_DIR };
