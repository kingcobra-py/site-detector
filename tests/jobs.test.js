import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJob, getJob, getJobItems, getJobUrls, resolveThreads, stopJob } from "../server/jobs.js";

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
  });

  it("treats 0 threads as one worker per URL and does not cap a high thread count", () => {
    assert.equal(resolveThreads(0, 50000), 50000);
    assert.equal(resolveThreads("unlimited", 1200), 1200);
    assert.equal(resolveThreads(250, 50000), 250);
    assert.equal(resolveThreads(9999, 80), 9999);
  });
});
