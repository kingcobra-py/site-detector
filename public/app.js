const form = document.querySelector("#detect-form");
const input = document.querySelector("#url");
const submit = document.querySelector("#submit");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");

function showStatus(message, isError = false) {
  statusEl.classList.remove("hidden");
  statusEl.classList.toggle("error", isError);
  statusEl.textContent = message;
}

function hideStatus() {
  statusEl.classList.add("hidden");
  statusEl.textContent = "";
}

function highlightGroup(id) {
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.group === id);
    if (chip.dataset.group === id) {
      chip.style.setProperty("--match", `var(--${id})`);
    }
  });
}

function renderResult(data) {
  const group = data.group || { id: "unknown", label: "Unknown / Other" };
  const matches = (data.matches || [])
    .map((m) => `<li>${escapeHtml(m.term)} × ${m.focusedHits + m.bodyHits}</li>`)
    .join("");
  const ranked = (data.ranked || [])
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.id)}</td><td>${Number(row.score).toFixed(1)}</td></tr>`,
    )
    .join("");

  resultEl.classList.remove("hidden");
  resultEl.innerHTML = `
    <p class="meta">${escapeHtml(data.hostname || "")} · ${escapeHtml(data.finalUrl || "")}</p>
    <h2>${escapeHtml(data.title || "Untitled page")}</h2>
    <p class="meta">${escapeHtml(data.description || "No description found.")}</p>
    <div class="badge" style="background: color-mix(in srgb, var(--${group.id}) 22%, transparent); color: var(--${group.id})">
      ${escapeHtml(group.label)} · ${data.confidence}% confidence
    </div>
    <p>${escapeHtml(group.description || "")}</p>
    <h3>Signals</h3>
    <ul class="matches">${matches || "<li>No strong keyword hits</li>"}</ul>
    <table class="scores">
      <thead><tr><th>Group</th><th>Score</th></tr></thead>
      <tbody>${ranked}</tbody>
    </table>
  `;
  highlightGroup(group.id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resultEl.classList.add("hidden");
  highlightGroup("");
  submit.disabled = true;
  showStatus("Loading the URL and scanning the page…");

  try {
    const response = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: input.value }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Detection failed");
    }
    hideStatus();
    renderResult(data);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    submit.disabled = false;
  }
});
