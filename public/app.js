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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultEl.classList.add("hidden");
  setCounts([]);
  submit.disabled = true;
  showStatus("Loading the URLs and sorting them into groups…");

  try {
    const response = await fetch("/api/detect-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.value }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Detection failed");
    }
    hideStatus();
    renderGroups(data);
    if (!data.ok && data.failed) {
      showStatus(`None of the ${data.total} URLs could be loaded.`, true);
    }
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
