import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createJob, getJob, getJobItems, getJobUrls, stopJob } from "../server/jobs.js";

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
});
