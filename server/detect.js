import { classifyPage } from "./classify.js";
import { fetchPage, normalizeUrl } from "./fetchPage.js";
import { GROUPS, UNKNOWN_GROUP, groupById } from "./groups.js";

const CONCURRENCY = 6;

function cleanCandidate(value) {
  return String(value || "")
    .trim()
    .replace(/[.,;:)+\]}]+$/g, "");
}

export function extractUrlCandidates(input) {
  if (Array.isArray(input)) {
    return input.map(cleanCandidate).filter(Boolean);
  }

  const text = String(input || "");
  const fromLinks = (text.match(/https?:\/\/[^\s<>"'`]+/gi) || []).map(cleanCandidate);
  const fromLines = [];

  for (const line of text.split(/[\n\r]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length > 400 || /<!doctype|<html|<div|<body/i.test(trimmed)) {
      fromLines.push(...(trimmed.match(/https?:\/\/[^\s<>"'`]+/gi) || []).map(cleanCandidate));
      continue;
    }
    fromLines.push(...trimmed.split(/[,;\t ]+/).map(cleanCandidate).filter(Boolean));
  }

  return [...new Set([...fromLines, ...fromLinks])];
}

export function parseUrlList(input) {
  const raw = extractUrlCandidates(input);

  const seen = new Set();
  const urls = [];
  const invalid = [];

  for (const item of raw) {
    const trimmed = String(item || "").trim();
    if (!trimmed) continue;
    try {
      const url = normalizeUrl(trimmed);
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    } catch (error) {
      invalid.push({ url: trimmed, error: error.message });
    }
  }

  return { urls, invalid };
}

export function summarizeResult(page, result) {
  return {
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
  };
}

export async function detectOne(input) {
  const requestedUrl = normalizeUrl(input);
  try {
    const page = await fetchPage(input);
    return summarizeResult(page, classifyPage({ html: page.html, url: page.url }));
  } catch (error) {
    const result = classifyPage({ html: "", url: requestedUrl });
    if (result.group.id !== "unknown") {
      return summarizeResult(
        {
          requestedUrl,
          url: requestedUrl,
          status: 0,
        },
        result,
      );
    }
    throw error;
  }
}

export function groupResults(items, errors = []) {
  const buckets = new Map();
  for (const group of [...GROUPS, UNKNOWN_GROUP]) {
    buckets.set(group.id, { ...group, items: [] });
  }

  for (const item of items) {
    const id = item.group?.id || "unknown";
    if (!buckets.has(id)) {
      buckets.set(id, { ...groupById(id), items: [] });
    }
    buckets.get(id).items.push(item);
  }

  return {
    total: items.length + errors.length,
    ok: items.length,
    failed: errors.length,
    groups: [...buckets.values()],
    errors,
  };
}

async function mapPool(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;

  async function run() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

export async function detectMany(input) {
  const { urls, invalid } = parseUrlList(input);
  const errors = [...invalid];
  const items = [];

  await mapPool(urls, CONCURRENCY, async (url) => {
    try {
      items.push(await detectOne(url));
    } catch (error) {
      errors.push({ url, error: error.message || "Could not analyze that site" });
    }
  });

  return groupResults(items, errors);
}
