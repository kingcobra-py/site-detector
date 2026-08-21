import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearFailed, createJob, getJob, getJobItems, getJobUrls, resolveThreads, resumeJob, stopJob } from "../server/jobs.js";
import { canScreenshotGroup } from "../server/screenshot.js";

describe("jobs", () => {
  it("starts a saved scan and keeps invalid URLs as failures", async () => {
    const job = await createJob({ text: "http://127.0.0.1\nhttp://localhost", threads: 2 });
    assert.ok(job.id);
    assert.equal(job.queued, 2);
    assert.equal(job.failed, 2);
    assert.equal(getJob(job.id).failed, 2);
    const page = getJobItems(job.id);
    assert.equal(page.errorTotal, 2);
    assert.match(getJobUrls(job.id, "errors"), /127\.0\.0\.1/);
    const stopped = stopJob(job.id);
    assert.ok(["stopped", "stopping", "done"].includes(stopped.status));
    const cleared = await clearFailed(job.id);
    assert.equal(cleared.failed, 0);
    assert.equal(getJobItems(job.id, "failed").errorTotal, 0);
  });

  it("returns null when resuming a missing scan", () => {
    assert.equal(resumeJob("missing-job"), null);
  });

  it("caps unlimited and huge thread counts so a 200k list cannot spawn 200k workers", () => {
    assert.equal(resolveThreads(0, 200000), 256);
    assert.equal(resolveThreads("unlimited", 1200), 256);
    assert.equal(resolveThreads(250, 50000), 250);
    assert.equal(resolveThreads(9999, 80), 256);
    assert.equal(resolveThreads(8, 200000), 8);
  });

  it("only allows screenshots for grouped matches", () => {
    assert.equal(canScreenshotGroup("digital_goods"), true);
    assert.equal(canScreenshotGroup("esim"), true);
    assert.equal(canScreenshotGroup("unknown"), false);
    assert.equal(canScreenshotGroup("failed"), false);
    assert.equal(canScreenshotGroup("errors"), false);
    assert.equal(canScreenshotGroup(""), false);
  });
});
