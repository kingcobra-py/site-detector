import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFromStored } from "./classify.js";
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

function sortByConfidence(items) {
  return [...items].sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0) || String(a.title || a.requestedUrl || "").localeCompare(String(b.title || b.requestedUrl || "")),
  );
}

function refineJobItems(job) {
  const counts = emptyCounts();
  job.items = (job.items || []).map((item) => {
    let next = item;
    if (item.groupId === "digital_goods") {
      const result = classifyFromStored(item);
      if (result.group.id === "unknown") {
        next = {
          ...item,
          groupId: "unknown",
          groupLabel: UNKNOWN_GROUP.label,
          confidence: 0,
        };
      }
    }
    counts[next.groupId] = (counts[next.groupId] || 0) + 1;
    return next;
  });
  job.counts = counts;
}

function publicJob(job, { includeItems = false } = {}) {
  const groups = [...GROUPS, UNKNOWN_GROUP].map((group) => ({
    ...group,
    count: job.counts[group.id] || 0,
    items: includeItems ? sortByConfidence(job.items.filter((item) => item.groupId === group.id)) : [],
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
    stopRequested: Boolean(job.stopRequested),
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
        stopRequested: Boolean(meta.stopRequested) && meta.status !== "running",
        abortControllers: new Set(),
        running: false,
      };
      const leftover = urls.length - (job.cursor || 0);
      const crashed = meta.status === "running";
      const unfinishedDone = meta.status === "done" && leftover > 0;
      if (job.status === "running") job.status = "stopped";
      job.resumeOnLoad = crashed || unfinishedDone;
      refineJobItems(job);
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

export function findJobItemByUrl(id, url) {
  const job = jobs.get(id);
  if (!job) return { job: null, item: null };
  const target = String(url || "").trim();
  const item =
    job.items.find((entry) => entry.requestedUrl === target || entry.finalUrl === target) || null;
  return { job, item };
}

function isFailedGroup(groupId) {
  return groupId === "failed" || groupId === "errors";
}

export function getJobItems(id, groupId, offset = 0, limit = 200) {
  const job = jobs.get(id);
  if (!job) return null;
  if (isFailedGroup(groupId)) {
    const errors = job.errors.slice(offset, offset + limit).map((item) => ({
      requestedUrl: item.url,
      finalUrl: item.url,
      title: item.url,
      hostname: "",
      confidence: 0,
      groupId: "failed",
      error: item.error,
    }));
    return {
      id: job.id,
      groupId: "failed",
      total: job.errors.length,
      offset,
      items: errors,
      errors: job.errors.slice(offset, offset + limit),
      errorTotal: job.errors.length,
    };
  }
  const items = sortByConfidence(groupId ? job.items.filter((item) => item.groupId === groupId) : job.items);
  const errors = groupId ? [] : job.errors;
  return {
    id: job.id,
    groupId: groupId || null,
    total: items.length,
    offset,
    items: items.slice(offset, offset + limit),
    errors: errors.slice(offset, offset + limit),
    errorTotal: errors.length,
  };
}

export function getJobUrls(id, groupId) {
  const job = jobs.get(id);
  if (!job) return null;
  if (isFailedGroup(groupId)) {
    return job.errors.map((item) => item.url).join("\n");
  }
  return sortByConfidence(
    job.items.filter((item) => !groupId || item.groupId === groupId),
  )
    .map((item) => item.finalUrl || item.requestedUrl)
    .join("\n");
}

export async function clearFailed(id) {
  const job = jobs.get(id);
  if (!job) return null;
  const removed = job.errors.length;
  job.errors = [];
  job.failed = 0;
  job.processed = job.ok;
  job.updatedAt = Date.now();
  await writeFile(path.join(jobDir(job.id), "errors.jsonl"), "");
  await persistMeta(job);
  return { ...publicJob(job), cleared: removed };
}

export function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.stopRequested = true;
  job.status = "stopped";
  job.updatedAt = Date.now();
  for (const controller of job.abortControllers || []) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
  persistMeta(job).catch(() => {});
  return publicJob(job);
}

export function resumeJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.running || job.status === "running") return publicJob(job);
  if ((job.cursor || 0) >= (job.urls?.length || 0)) {
    job.status = "done";
    persistMeta(job).catch(() => {});
    return publicJob(job);
  }
  job.stopRequested = false;
  job.error = null;
  job.restarts = 0;
  job.status = "queued";
  persistMeta(job).catch(() => {});
  runJob(job).catch((error) => {
    job.running = false;
    job.status = "error";
    job.error = error.message;
  });
  return publicJob(job);
}

export function resumeIncompleteJobs() {
  const resumed = [];
  for (const job of jobs.values()) {
    if (!job.resumeOnLoad) continue;
    delete job.resumeOnLoad;
    resumeJob(job.id);
    resumed.push(job.id);
  }
  return resumed;
}

async function runJob(job) {
  if (job.running) return;
  job.running = true;
  activeJobId = job.id;
  job.stopRequested = false;
  job.status = "running";
  job.updatedAt = Date.now();
  await persistMeta(job);

  const threads = Math.max(1, job.threads || 8);
  let next = job.cursor || 0;

  job.abortControllers = job.abortControllers || new Set();

  async function worker() {
    while (true) {
      if (job.stopRequested) return;
      const index = next;
      next += 1;
      if (index >= job.urls.length) return;
      const url = job.urls[index];
      const controller = new AbortController();
      job.abortControllers.add(controller);
      try {
        const result = slimItem(await detectOne(url, { signal: controller.signal }));
        if (job.stopRequested) return;
        job.items.push(result);
        job.ok += 1;
        job.counts[result.groupId] = (job.counts[result.groupId] || 0) + 1;
        await persistItem(job, result);
      } catch (error) {
        if (job.stopRequested || error.code === "STOPPED") return;
        const failed = { url, error: error.message || "Could not analyze that site" };
        job.errors.push(failed);
        job.failed += 1;
        await persistError(job, failed);
      } finally {
        job.abortControllers.delete(controller);
      }
      job.processed += 1;
      job.cursor = Math.max(job.cursor || 0, index + 1);
      job.updatedAt = Date.now();
      if (job.processed % 25 === 0) await persistMeta(job);
    }
  }

  try {
    const leftover = Math.max(0, job.urls.length - next);
    await Promise.all(Array.from({ length: Math.min(threads, leftover || job.urls.length) }, worker));
    if (job.stopRequested) {
      job.status = "stopped";
    } else if ((job.cursor || 0) >= job.urls.length) {
      job.status = "done";
    } else {
      job.restarts = (job.restarts || 0) + 1;
      if (job.restarts > 20) {
        job.status = "error";
        job.error = "Scan workers stopped before finishing. Click Resume to continue.";
      } else {
        job.running = false;
        job.updatedAt = Date.now();
        await persistMeta(job);
        return runJob(job);
      }
    }
  } catch (error) {
    job.status = "error";
    job.error = error.message;
  }
  job.running = false;
  job.updatedAt = Date.now();
  await persistMeta(job);
}

export const MAX_THREADS = 256;

export function resolveThreads(requested, urlCount) {
  const count = Math.max(1, urlCount || 1);
  let n;
  if (requested === 0 || requested === "unlimited" || requested === "0") {
    n = count;
  } else {
    n = Number(requested);
    if (!Number.isFinite(n) || n < 1) n = Math.min(8, count);
  }
  return Math.max(1, Math.min(MAX_THREADS, Math.round(n)));
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
    abortControllers: new Set(),
    running: false,
  };
  jobs.set(id, job);
  await persistUrls(job);
  await persistMeta(job);
  if (job.errors.length) {
    await appendFile(
      path.join(jobDir(job.id), "errors.jsonl"),
      `${job.errors.map((item) => JSON.stringify(item)).join("\n")}\n`,
    );
  }
  runJob(job).catch((error) => {
    job.status = "error";
    job.error = error.message;
  });
  return publicJob(job);
}

export { publicJob, DATA_DIR };
