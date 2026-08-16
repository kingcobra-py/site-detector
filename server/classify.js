import * as cheerio from "cheerio";
import { GROUPS, SIGNALS, UNKNOWN_GROUP, groupById } from "./groups.js";

const WORD_BOUNDARY_CACHE = new Map();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function foldText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function countMatches(haystack, term) {
  const folded = foldText(term);
  let pattern = WORD_BOUNDARY_CACHE.get(folded);
  if (!pattern) {
    const escaped = escapeRegExp(folded);
    const spaceless = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(
      folded,
    );
    const bounded =
      !spaceless && /^[\p{L}\p{N}]/u.test(folded) && /[\p{L}\p{N}]$/u.test(folded);
    pattern = new RegExp(
      bounded ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped,
      "gu",
    );
    WORD_BOUNDARY_CACHE.set(folded, pattern);
  }
  const matches = haystack.match(pattern);
  return matches ? matches.length : 0;
}

function normalizeText(value) {
  return foldText(value)
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/g, " ")
    .replace(/[^\p{L}\p{N}+.\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSignals(html, url = "") {
  const raw = String(html || "");
  const $ = cheerio.load(raw);
  $("script, style, noscript, svg").remove();

  const title =
    $("title").first().text() ||
    $('meta[property="og:title"]').attr("content") ||
    "";
  const description =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  const keywords = $('meta[name="keywords"]').attr("content") || "";
  const headings = $("h1, h2, h3")
    .map((_, el) => $(el).text())
    .get()
    .join(" ");

  let hostname = "";
  let urlText = "";
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.replace(/^www\./, "");
    urlText = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.replace(/[/?#=&._-]+/g, " ");
  } catch {
    hostname = "";
  }

  const body = normalizeText($("body").text() || raw).slice(0, 80_000);
  const focused = normalizeText([title, description, keywords, headings, hostname, urlText].join(" "));

  return {
    title: normalizeText(title),
    description: normalizeText(description),
    hostname,
    focused,
    body,
    combined: `${focused} ${focused} ${body}`,
  };
}

export function scoreGroups(textBundle) {
  const scores = {};
  const matches = {};

  for (const group of GROUPS) {
    scores[group.id] = 0;
    matches[group.id] = [];
    const signals = SIGNALS[group.id] || [];

    for (const { term, weight } of signals) {
      const focusedHits = countMatches(textBundle.focused, term);
      const bodyHits = countMatches(textBundle.body, term);
      if (!focusedHits && !bodyHits) continue;

      const points = focusedHits * weight * 2.4 + Math.min(bodyHits, 8) * weight;
      scores[group.id] += points;
      matches[group.id].push({
        term,
        weight,
        focusedHits,
        bodyHits,
        points: Number(points.toFixed(1)),
      });
    }

    matches[group.id].sort((a, b) => b.points - a.points);
    matches[group.id] = matches[group.id].slice(0, 8);
  }

  return { scores, matches };
}

export function pickWinner(scores) {
  const ranked = Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || { id: "unknown", score: 0 };
  const second = ranked[1] || { id: "unknown", score: 0 };
  const minScore = 8;

  if (best.score < minScore) {
    return {
      group: UNKNOWN_GROUP,
      confidence: 0,
      ranked,
    };
  }

  const gap = best.score - second.score;
  const confidence = Math.min(
    99,
    Math.round(40 + Math.min(best.score, 80) * 0.45 + Math.min(gap, 40) * 0.7),
  );

  return {
    group: groupById(best.id),
    confidence,
    ranked,
  };
}

export function classifyPage({ html, url }) {
  const extracted = extractSignals(html, url);
  const { scores, matches } = scoreGroups(extracted);
  const { group, confidence, ranked } = pickWinner(scores);

  return {
    url,
    hostname: extracted.hostname,
    title: extracted.title,
    description: extracted.description,
    group,
    confidence,
    scores,
    ranked,
    matches: matches[group.id] || [],
    allMatches: matches,
  };
}
