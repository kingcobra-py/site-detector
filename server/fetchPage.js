import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

export function isPrivateIp(ip) {
  if (!ip) return true;

  if (ip.includes(":") && !ip.includes(".")) {
    const compact = ip.toLowerCase();
    return (
      compact === "::1" ||
      compact === "::" ||
      compact.startsWith("fe80:") ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      compact.startsWith("::ffff:127.") ||
      compact.startsWith("::ffff:10.") ||
      compact.startsWith("::ffff:192.168.")
    );
  }

  const v4 = ip.includes(":") ? ip.split(":").pop() : ip;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("URL is required");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("Enter a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with credentials are not allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That host is not allowed");
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new Error("Private or local addresses are not allowed");
  }
  return parsed.toString();
}

async function assertPublicHost(hostname) {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private or local addresses are not allowed");
    return;
  }
  const records = await lookup(hostname, { all: true });
  if (!records.length) throw new Error("Could not resolve that host");
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error("Private or local addresses are not allowed");
    }
  }
}

export async function fetchPage(inputUrl) {
  const startUrl = normalizeUrl(inputUrl);
  let current = startUrl;
  let lastError = "Could not load the page";

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = new URL(current);
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; SiteDetector/1.0; +https://github.com/kingcobra-py/site-detector)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect without a location");
        current = new URL(location, current).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Site returned HTTP ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (
        contentType &&
        !/text\/html|application\/xhtml|text\/plain|application\/xml/i.test(contentType)
      ) {
        throw new Error("That URL did not return an HTML page");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response from site");

      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }

      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      return {
        url: current,
        requestedUrl: startUrl,
        status: response.status,
        contentType,
        html,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        lastError = "Timed out while loading the site";
      } else {
        lastError = error.message || lastError;
      }
      throw new Error(lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("Too many redirects");
}
