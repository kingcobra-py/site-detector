import { lookup, setDefaultResultOrder } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

setDefaultResultOrder("ipv4first");

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const dispatcher = new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 10_000,
  connect: {
    rejectUnauthorized: false,
    timeout: 8_000,
  },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

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

export function isUserStop(signal, error) {
  return Boolean(signal?.aborted) || error?.code === "STOPPED";
}

function stoppedError() {
  return Object.assign(new Error("Stopped"), { code: "STOPPED" });
}

function fetchErrorMessage(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  if (error?.name === "AbortError" || code === "UND_ERR_ABORTED") return "Timed out while loading the site";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Domain not found";
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code === "ECONNRESET") return "Connection reset";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "Timed out while connecting";
  if (code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return "TLS certificate error";
  }
  return cause?.message || error.message || "Could not load the page";
}

async function assertPublicHost(hostname) {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Private or local addresses are not allowed");
    return;
  }
  const records = await lookup(hostname, { all: true, verbatim: false });
  if (!records.length) throw new Error("Could not resolve that host");
  const publicRecords = records.filter((record) => !isPrivateIp(record.address));
  if (!publicRecords.length) {
    throw new Error("Private or local addresses are not allowed");
  }
}

function linkSignals(...signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller;
}

async function fetchOnce(current, externalSignal) {
  const controller = linkSignals(externalSignal);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await undiciFetch(current, {
      method: "GET",
      redirect: "follow",
      maxRedirections: MAX_REDIRECTS,
      signal: controller.signal,
      dispatcher,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok && response.status !== 403 && response.status !== 401) {
      throw new Error(`Site returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      contentType &&
      !/text\/html|application\/xhtml|text\/plain|application\/xml|application\/json/i.test(contentType)
    ) {
      return {
        url: String(response.url || current),
        status: response.status,
        contentType,
        html: "",
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { url: String(response.url || current), status: response.status, contentType, html: "" };
    }

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

    return {
      url: String(response.url || current),
      status: response.status,
      contentType,
      html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(inputUrl, { signal } = {}) {
  const startUrl = normalizeUrl(inputUrl);
  const parsed = new URL(startUrl);
  await assertPublicHost(parsed.hostname);

  let lastError = "Could not load the page";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw stoppedError();
    try {
      const page = await fetchOnce(startUrl, signal);
      return {
        url: page.url,
        requestedUrl: startUrl,
        status: page.status,
        contentType: page.contentType,
        html: page.html,
      };
    } catch (error) {
      if (isUserStop(signal, error)) throw stoppedError();
      lastError = fetchErrorMessage(error);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(lastError);
}
