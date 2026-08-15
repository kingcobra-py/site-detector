const form = document.querySelector("#detect-form");
const input = document.querySelector("#urls");
const submit = document.querySelector("#submit");
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

function showStatus(message, isError = false) {
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", isError);
  statusEl.textContent = message;
}

function hideStatus() {
  statusEl.classList.add("hidden");
  statusEl.textContent = "";
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
    const n = counts[chip.dataset.group] || 0;
    chip.classList.toggle("active", n > 0);
    chip.style.setProperty("--match", `var(--${chip.dataset.group})`);
  });
}

function renderGroups(data) {
  const groups = (data.groups || []).filter((group) => group.items?.length);
  const errors = data.errors || [];
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
          <h2><span class="dot"></span>${escapeHtml(group.label)}</h2>
          <button type="button" class="copy" data-copy="${escapeHtml(group.id)}">Copy URLs</button>
        </header>
        <ol>${rows}</ol>
      </article>`;
    })
    .join("");

  const errorHtml = errors.length
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

  resultEl.classList.remove("hidden");
  resultEl.innerHTML = `
    <p class="meta">${data.ok} grouped · ${data.failed} failed · ${data.total} total</p>
    ${groupHtml || "<p class='meta'>No sites landed in a tracked group yet.</p>"}
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

const BATCH_SIZE = 10;
let runId = 0;

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The server sent a web page instead of results. Try Detect all again.");
  }
}

function emptyGroups() {
  return GROUP_ORDER.map((id) => ({ id, items: [] }));
}

function mergeBatch(state, batch) {
  const byId = new Map((state.groups || emptyGroups()).map((group) => [group.id, { ...group, items: [...(group.items || [])] }]));
  for (const group of batch.groups || []) {
    if (!byId.has(group.id)) {
      byId.set(group.id, { ...group, items: [] });
    }
    const target = byId.get(group.id);
    if (!target.label && group.label) Object.assign(target, group, { items: target.items });
    target.items.push(...(group.items || []));
  }
  return {
    total: state.total + (batch.total || 0),
    ok: state.ok + (batch.ok || 0),
    failed: state.failed + (batch.failed || 0),
    groups: [...byId.values()],
    errors: [...(state.errors || []), ...(batch.errors || [])],
  };
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const thisRun = ++runId;
  resultEl.classList.add("hidden");
  setCounts([]);
  submit.disabled = true;

  try {
    const urls = extractUrls(input.value);
    if (!urls.length) {
      throw new Error("Paste at least one URL.");
    }

    showStatus(`Scanning 0 / ${urls.length}…`);
    let state = { total: 0, ok: 0, failed: 0, groups: emptyGroups(), errors: [] };

    for (const batch of chunk(urls, BATCH_SIZE)) {
      if (thisRun !== runId) return;
      const response = await fetch("/api/detect-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: batch }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(data.error || "Detection failed");
      }
      state = mergeBatch(state, data);
      renderGroups(state);
      showStatus(`Scanning ${state.total} / ${urls.length}…`);
    }

    if (thisRun !== runId) return;
    if (!state.ok && state.failed) {
      showStatus(`None of the ${state.total} URLs could be loaded.`, true);
    } else {
      showStatus(`Done. ${state.ok} grouped · ${state.failed} failed · ${state.total} total.`);
    }
  } catch (error) {
    if (thisRun === runId) showStatus(error.message, true);
  } finally {
    if (thisRun === runId) submit.disabled = false;
  }
});
