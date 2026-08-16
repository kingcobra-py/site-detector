const form = document.querySelector("#detect-form");
const input = document.querySelector("#urls");
const threadsInput = document.querySelector("#threads");
const unlimitedThreads = document.querySelector("#unlimited-threads");
const submit = document.querySelector("#submit");
const stopBtn = document.querySelector("#stop");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");

const GROUP_ORDER = [
  "digital_goods",
  "esim",
  "clothing",
  "hosting",
  "proxies",
  "gambling",
  "donation",
  "unknown",
  "failed",
];

let activeFilter = null;
let currentJob = null;
let pollTimer = null;
let itemOffset = 0;

function showStatus(message, isError = false) {
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", isError);
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function threadCount() {
  if (unlimitedThreads?.checked) return 0;
  const n = Number(threadsInput.value);
  if (!Number.isFinite(n) || n < 1) return 8;
  return Math.round(n);
}

unlimitedThreads?.addEventListener("change", () => {
  threadsInput.disabled = unlimitedThreads.checked;
});

function setCounts(counts, failed = 0) {
  const merged = { ...counts, failed };
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = String(merged?.[el.dataset.count] || 0);
  });
  document.querySelectorAll(".chip").forEach((chip) => {
    const id = chip.dataset.group;
    const n = merged?.[id] || 0;
    chip.classList.toggle("active", n > 0);
    chip.classList.toggle("selected", activeFilter === id);
    chip.classList.toggle("dim", Boolean(activeFilter) && activeFilter !== id);
    chip.style.setProperty("--match", `var(--${id})`);
  });
}

function canResume(job) {
  return Boolean(job && job.status !== "running" && job.status !== "queued" && job.status !== "stopping" && job.processed < job.queued);
}

function setRunning(running, job = currentJob) {
  submit.disabled = running;
  const resume = !running && canResume(job);
  stopBtn.classList.toggle("idle", !running && !resume);
  stopBtn.textContent = running ? "Stop" : resume ? "Resume" : "Stop";
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The server sent a web page instead of results. Refresh and try again.");
  }
}

function renderJob(job, page) {
  currentJob = job;
  setCounts(job.counts, job.failed);
  setRunning(job.status === "running" || job.status === "queued" || job.status === "stopping", job);

  const stalled = job.processed < job.queued && job.status !== "running" && job.status !== "queued" && job.status !== "stopping";
  const label =
    job.status === "running"
      ? `Scanning ${job.processed} / ${job.queued} with ${job.threads} threads. Results stay on this site.`
      : job.status === "stopping"
        ? `Stopping… ${job.processed} / ${job.queued} saved.`
        : job.status === "stopped"
          ? `Stopped. ${job.ok} grouped · ${job.failed} failed · ${job.processed} / ${job.queued} saved. Click Resume to continue.`
          : stalled
            ? `Scan stalled at ${job.processed} / ${job.queued}. Click Resume to continue from where it left off.`
            : job.status === "done"
              ? `Done. ${job.ok} grouped · ${job.failed} failed · ${job.processed} total. Results are saved on the server.`
              : `${job.status}. ${job.processed} / ${job.queued}`;
  showStatus(job.error || label, Boolean(job.error));

  const filter = activeFilter;
  const failedFilter = filter === "failed";
  const items = page?.items || [];
  const errors = failedFilter ? page?.errors || items : !filter ? page?.errors || [] : [];
  const groupMeta = (job.groups || []).find((group) => group.id === filter);
  const shown = failedFilter ? job.failed : filter ? groupMeta?.count || items.length : job.ok;

  const rows = items
    .map((item) => {
      const href = escapeHtml(item.finalUrl || item.requestedUrl);
      const title = escapeHtml(item.title || item.hostname || "Untitled page");
      const url = escapeHtml(item.finalUrl || item.requestedUrl);
      return `<li>
        <a href="${href}" target="_blank" rel="noreferrer">${title}</a>
        <span class="meta">${url}${item.confidence ? ` · ${item.confidence}%` : ""}</span>
      </li>`;
    })
    .join("");

  const errorRows = errors
    .map(
      (item) =>
        `<li><span>${escapeHtml(item.url)}</span><span class="meta">${escapeHtml(item.error)}</span></li>`,
    )
    .join("");

  const more =
    filter && (page?.total || 0) > items.length + (page?.offset || 0)
      ? `<button type="button" class="copy" id="more">Show more</button>`
      : "";

  resultEl.classList.remove("hidden");
  resultEl.innerHTML = `
    <p class="meta">${job.ok} grouped · ${job.failed} failed · ${job.processed} / ${job.queued} scanned</p>
    ${
      failedFilter
        ? `<article class="bucket error-bucket" data-group="failed">
            <header>
              <h2>Failed (${job.failed})</h2>
              <div class="buttons">
                <button type="button" class="copy" data-copy="failed">Copy URLs</button>
                <button type="button" class="stop" id="clear-failed">Clear failed</button>
              </div>
            </header>
            <p class="meta">Showing ${errors.length} of ${job.failed}. Clear removes them from this scan.</p>
            <ol>${
              errors
                .map(
                  (item) =>
                    `<li><span>${escapeHtml(item.url || item.requestedUrl)}</span><span class="meta">${escapeHtml(item.error || "")}</span></li>`,
                )
                .join("") || "<li class='meta'>No failed URLs.</li>"
            }</ol>
            ${more}
          </article>`
        : filter
          ? `<article class="bucket" data-group="${escapeHtml(filter)}">
            <header>
              <h2><span class="dot"></span>${escapeHtml(groupMeta?.label || filter)}</h2>
              <button type="button" class="copy" data-copy="${escapeHtml(filter)}">Copy URLs</button>
            </header>
            <p class="meta">Showing ${items.length} of ${shown}. Tap the group again to show all counts only.</p>
            <ol>${rows || "<li class='meta'>No URLs in this group yet.</li>"}</ol>
            ${more}
          </article>`
          : `<p class="meta">Tap a group above to list its URLs. Tap Failed to review or clear load errors.</p>`
    }
  `;

  resultEl.querySelector("[data-copy]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      const response = await fetch(`/api/jobs/${job.id}/urls?group=${encodeURIComponent(filter)}`);
      const text = await response.text();
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy URLs";
      }, 1200);
    } catch {
      button.textContent = "Copy failed";
    }
  });

  resultEl.querySelector("#more")?.addEventListener("click", () => {
    itemOffset += 200;
    loadItems(job.id, filter, itemOffset, true);
  });

  resultEl.querySelector("#clear-failed")?.addEventListener("click", async () => {
    const response = await fetch(`/api/jobs/${job.id}/clear-failed`, { method: "POST" });
    const next = await readJson(response);
    if (!response.ok) {
      showStatus(next.error || "Could not clear failed URLs", true);
      return;
    }
    activeFilter = null;
    await refreshJob(next.id);
    showStatus(`Cleared failed URLs. ${next.ok} grouped results remain.`);
  });
}

async function loadItems(jobId, group, offset = 0, append = false) {
  if (!group) {
    renderJob(currentJob, { items: [], errors: [] });
    return;
  }
  const response = await fetch(
    `/api/jobs/${jobId}/items?group=${encodeURIComponent(group)}&offset=${offset}&limit=200`,
  );
  const page = await readJson(response);
  if (append && currentJob) {
    page.items = [...(resultEl._items || []), ...page.items];
    page.offset = 0;
  }
  resultEl._items = page.items;
  renderJob(currentJob, page);
}

async function refreshJob(id) {
  const response = await fetch(id ? `/api/jobs/${id}` : "/api/jobs/latest");
  if (response.status === 404) return null;
  const job = await readJson(response);
  if (!response.ok) throw new Error(job.error || "Could not load scan");
  currentJob = job;
  if (activeFilter) {
    await loadItems(job.id, activeFilter, 0, false);
  } else {
    const errors = await fetch(`/api/jobs/${job.id}/items?limit=30`);
    const page = errors.ok ? await readJson(errors) : { items: [], errors: [] };
    renderJob(job, { items: [], errors: page.errors || [] });
  }
  return job;
}

function startPolling(id) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const job = await refreshJob(id);
      if (!job || (job.status !== "running" && job.status !== "queued" && job.status !== "stopping")) {
        clearInterval(pollTimer);
        setRunning(false);
      }
    } catch (error) {
      showStatus(error.message, true);
    }
  }, 1500);
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    const id = chip.dataset.group;
    activeFilter = activeFilter === id ? null : id;
    itemOffset = 0;
    if (!currentJob) return;
    setCounts(currentJob.counts, currentJob.failed);
    if (activeFilter) await loadItems(currentJob.id, activeFilter, 0, false);
    else await refreshJob(currentJob.id);
  });
});

stopBtn.addEventListener("click", async () => {
  try {
    let id = currentJob?.id;
    if (!id) {
      const latest = await fetch("/api/jobs/latest");
      if (latest.ok) id = (await readJson(latest)).id;
    }
    if (!id) {
      showStatus("No scan is running.", true);
      return;
    }
    if (canResume(currentJob)) {
      showStatus("Resuming the saved scan…");
      const response = await fetch(`/api/jobs/${id}/resume`, { method: "POST" });
      const job = await readJson(response);
      if (!response.ok) throw new Error(job.error || "Could not resume");
      renderJob(job, { items: [], errors: [] });
      startPolling(job.id);
      return;
    }
    showStatus("Stopping… cancelling in-flight checks.");
    const response = await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
    const job = await readJson(response);
    if (!response.ok) throw new Error(job.error || "Could not stop");
    clearInterval(pollTimer);
    renderJob(job, { items: [], errors: [] });
    setRunning(false, job);
    showStatus(`Stopped. ${job.ok} grouped · ${job.failed} failed · ${job.processed} saved. Click Resume to continue.`);
  } catch (error) {
    showStatus(error.message, true);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  activeFilter = null;
  itemOffset = 0;
  setRunning(true);
  showStatus("Starting a server scan. This stays on the site even if you close the tab.");

  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.value, threads: threadCount() }),
    });
    const job = await readJson(response);
    if (!response.ok) throw new Error(job.error || "Could not start scan");
    renderJob(job, { items: [], errors: [] });
    startPolling(job.id);
  } catch (error) {
    setRunning(false);
    showStatus(error.message, true);
  }
});

refreshJob()
  .then((job) => {
    if (job && (job.status === "running" || job.status === "queued" || job.status === "stopping")) {
      startPolling(job.id);
    }
  })
  .catch(() => {});
