const form = document.querySelector("#detect-form");
const input = document.querySelector("#urls");
const threadsInput = document.querySelector("#threads");
const submit = document.querySelector("#submit");
const stopBtn = document.querySelector("#stop");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");

const GROUP_ORDER = [
  "digital_goods",
  "esim",
  "clothing",
  "hosting",
  "gambling",
  "donation",
  "unknown",
];

let runId = 0;
let activeFilter = null;
let lastState = { total: 0, ok: 0, failed: 0, groups: emptyGroups(), errors: [] };
let controllers = [];

function emptyGroups() {
  return GROUP_ORDER.map((id) => ({ id, items: [] }));
}

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

function setCounts(groups) {
  const counts = Object.fromEntries(GROUP_ORDER.map((id) => [id, 0]));
  for (const group of groups || []) {
    counts[group.id] = group.items?.length || 0;
  }
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = String(counts[el.dataset.count] || 0);
  });
  document.querySelectorAll(".chip").forEach((chip) => {
    const id = chip.dataset.group;
    const n = counts[id] || 0;
    chip.classList.toggle("active", n > 0);
    chip.classList.toggle("selected", activeFilter === id);
    chip.classList.toggle("dim", Boolean(activeFilter) && activeFilter !== id);
    chip.style.setProperty("--match", `var(--${id})`);
  });
}

function renderGroups(data) {
  lastState = data;
  const filter = activeFilter;
  const groups = (data.groups || []).filter((group) => {
    if (!group.items?.length) return false;
    return !filter || group.id === filter;
  });
  const errors = filter && filter !== "unknown" ? [] : data.errors || [];
  setCounts(data.groups);

  const groupHtml = groups
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const href = escapeHtml(item.finalUrl || item.requestedUrl);
          const title = escapeHtml(item.title || item.hostname || "Untitled page");
          const url = escapeHtml(item.finalUrl || item.requestedUrl);
          return `<li>
            <a href="${href}" target="_blank" rel="noreferrer">${title}</a>
            <span class="meta">${url} · ${item.confidence}%</span>
          </li>`;
        })
        .join("");
      return `<article class="bucket" data-group="${escapeHtml(group.id)}">
        <header>
          <h2><span class="dot"></span>${escapeHtml(group.label || group.id)}</h2>
          <button type="button" class="copy" data-copy="${escapeHtml(group.id)}">Copy URLs</button>
        </header>
        <ol>${rows}</ol>
      </article>`;
    })
    .join("");

  const errorHtml =
    errors.length && !filter
      ? `<article class="bucket error-bucket">
        <header><h2>Could not load</h2></header>
        <ol>${errors
          .map(
            (item) =>
              `<li><span>${escapeHtml(item.url)}</span><span class="meta">${escapeHtml(item.error)}</span></li>`,
          )
          .join("")}</ol>
      </article>`
      : "";

  const filterNote = filter
    ? `<p class="meta">Showing ${filter.replaceAll("_", " ")} only. Tap the group again to show all.</p>`
    : "";

  resultEl.classList.remove("hidden");
  resultEl.innerHTML = `
    <p class="meta">${data.ok} grouped · ${data.failed} failed · ${data.total} total</p>
    ${filterNote}
    ${groupHtml || "<p class='meta'>No URLs in this group yet.</p>"}
    ${errorHtml}
  `;

  resultEl.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const group = (data.groups || []).find((g) => g.id === button.dataset.copy);
      const text = (group?.items || [])
        .map((item) => item.finalUrl || item.requestedUrl)
        .join("\n");
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = "Copy URLs";
        }, 1200);
      } catch {
        button.textContent = "Copy failed";
      }
    });
  });
}

function extractUrls(text) {
  const found = [];
  const seen = new Set();
  for (const line of String(text || "").split(/[\n\r]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const embedded = trimmed.match(/https?:\/\/[^\s<>"'`]+/gi);
    const parts =
      embedded && (embedded.length > 1 || trimmed.length > 400 || /<!doctype|<html/i.test(trimmed))
        ? embedded
        : trimmed.split(/[,;\t ]+/).filter(Boolean);
    for (const part of parts) {
      const url = part.trim().replace(/[.,;:)+\]}]+$/g, "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      found.push(url);
    }
  }
  return found;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The server sent a web page instead of results. Try Detect all again.");
  }
}

function addItem(state, item) {
  const id = item.group?.id || "unknown";
  let found = false;
  const groups = state.groups.map((group) => {
    if (group.id !== id) return group;
    found = true;
    return { ...group, ...item.group, items: [...group.items, item] };
  });
  if (!found) groups.push({ ...item.group, items: [item] });
  return { ...state, total: state.total + 1, ok: state.ok + 1, groups };
}

function addError(state, url, error) {
  return {
    ...state,
    total: state.total + 1,
    failed: state.failed + 1,
    errors: [...state.errors, { url, error }],
  };
}

function threadCount() {
  const n = Number(threadsInput.value);
  if (!Number.isFinite(n)) return 8;
  return Math.min(16, Math.max(1, Math.round(n)));
}

function stopScan(message = "Stopped.") {
  runId += 1;
  for (const controller of controllers) controller.abort();
  controllers = [];
  submit.disabled = false;
  stopBtn.disabled = true;
  showStatus(message);
}

async function runPool(urls, threads, worker) {
  let next = 0;
  async function thread() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= urls.length) return;
      await worker(urls[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(threads, urls.length) }, thread));
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const id = chip.dataset.group;
    activeFilter = activeFilter === id ? null : id;
    renderGroups(lastState);
  });
});

stopBtn.addEventListener("click", () => stopScan("Stopped. Partial results are kept."));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const thisRun = ++runId;
  for (const controller of controllers) controller.abort();
  controllers = [];
  activeFilter = null;
  lastState = { total: 0, ok: 0, failed: 0, groups: emptyGroups(), errors: [] };
  resultEl.classList.add("hidden");
  setCounts([]);
  submit.disabled = true;
  stopBtn.disabled = false;

  try {
    const urls = extractUrls(input.value);
    if (!urls.length) {
      throw new Error("Paste at least one URL.");
    }

    const threads = threadCount();
    showStatus(`Scanning 0 / ${urls.length} with ${threads} threads…`);
    renderGroups(lastState);

    await runPool(urls, threads, async (url) => {
      if (thisRun !== runId) return;
      const controller = new AbortController();
      controllers.push(controller);
      try {
        const response = await fetch("/api/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });
        const data = await readJson(response);
        if (thisRun !== runId) return;
        lastState = response.ok
          ? addItem(lastState, data)
          : addError(lastState, url, data.error || "Detection failed");
      } catch (error) {
        if (thisRun !== runId || error.name === "AbortError") return;
        lastState = addError(lastState, url, error.message || "Could not analyze that site");
      } finally {
        controllers = controllers.filter((item) => item !== controller);
      }
      if (thisRun === runId) {
        renderGroups(lastState);
        showStatus(`Scanning ${lastState.total} / ${urls.length} with ${threads} threads…`);
      }
    });

    if (thisRun !== runId) return;
    if (!lastState.ok && lastState.failed) {
      showStatus(`None of the ${lastState.total} URLs could be loaded.`, true);
    } else {
      showStatus(`Done. ${lastState.ok} grouped · ${lastState.failed} failed · ${lastState.total} total.`);
    }
  } catch (error) {
    if (thisRun === runId) showStatus(error.message, true);
  } finally {
    if (thisRun === runId) {
      submit.disabled = false;
      stopBtn.disabled = true;
    }
  }
});
