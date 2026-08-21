import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUrl } from "./fetchPage.js";

const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/screenshots");

const WIDTH = 1280;
const HEIGHT = 800;
const TIMEOUT_MS = 25_000;

let browserPromise = null;
let queue = Promise.resolve();

export function canScreenshotGroup(groupId) {
  return Boolean(groupId && groupId !== "unknown" && groupId !== "failed" && groupId !== "errors");
}

export function screenshotKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

function screenshotPath(url) {
  return path.join(SCREENSHOT_DIR, `${screenshotKey(url)}.jpg`);
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) =>
      chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      }),
    );
  }
  return browserPromise;
}

async function captureNow(url) {
  const file = screenshotPath(url);
  try {
    const info = await stat(file);
    if (info.size > 0) return file;
  } catch {
    // not cached yet
  }

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    } catch (error) {
      const current = page.url();
      if (!current || current === "about:blank") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.screenshot({
      path: file,
      type: "jpeg",
      quality: 72,
      fullPage: false,
    });
  } finally {
    await context.close();
  }
  return file;
}

export function captureScreenshot(inputUrl) {
  const url = normalizeUrl(inputUrl);
  const run = queue.then(() => captureNow(url));
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}
