const $ = (sel) => document.querySelector(sel);
const player = $("#player");
const playerEmpty = $("#player-empty");
const runsList = $("#runs-list");
const timeline = $("#timeline");
const runTitle = $("#run-title");
const runSub = $("#run-sub");
const runStats = $("#run-stats");
const feedbackNote = $("#feedback-note");
const copyPromptBtn = $("#copy-prompt");
const copyStatus = $("#copy-status");
const promptPreview = $("#prompt-preview");

const flagged = new Set();
let state = { runId: null, events: [], plan: null, startedAt: null, finishedAt: null };

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function statsFor(events) {
  const pass = events.filter((e) => e.outcome === "success").length;
  const fail = events.filter((e) => e.outcome === "failure").length;
  const skip = events.filter((e) => e.outcome === "skipped").length;
  return { pass, fail, skip, total: events.length };
}

async function loadRuns() {
  const res = await fetch("/api/runs");
  const runs = await res.json();
  if (!runs.length) {
    runsList.innerHTML = `<div class="dim" style="padding:8px 4px;font-size:12px;">No runs yet. Run <code>tik-test run</code> to create one.</div>`;
    return;
  }
  runsList.innerHTML = runs.map((r) => {
    const s = { pass: r.passed, fail: r.failed, skip: r.skipped, total: r.total };
    return `<div class="run-card" data-id="${r.id}">
      <h3>${escape(r.name)}</h3>
      <div class="meta">
        <span>${new Date(r.finishedAt).toLocaleString()}</span>
        <span class="stat-pass">${s.pass} pass</span>
        ${s.fail ? `<span class="stat-fail">${s.fail} fail</span>` : ""}
        ${s.skip ? `<span>${s.skip} skip</span>` : ""}
        <span>${(r.totalMs / 1000).toFixed(1)}s</span>
      </div>
    </div>`;
  }).join("");
  runsList.querySelectorAll(".run-card").forEach((card) => {
    card.addEventListener("click", () => selectRun(card.getAttribute("data-id")));
  });
  if (runs[0]) selectRun(runs[0].id);
}

async function selectRun(id) {
  runsList.querySelectorAll(".run-card").forEach((c) => c.classList.toggle("active", c.getAttribute("data-id") === id));
  const res = await fetch(`/api/runs/${id}`);
  const data = await res.json();
  state = { runId: id, events: data.events, plan: data.plan, startedAt: data.startedAt, finishedAt: data.finishedAt, totalMs: data.totalMs };
  flagged.clear();

  player.src = `/runs/${id}/highlights.mp4`;
  player.classList.add("ready");
  playerEmpty.style.display = "none";

  runTitle.textContent = data.plan?.name ?? id;
  runSub.textContent = `${data.plan?.startUrl ?? ""} · ${new Date(data.finishedAt).toLocaleString()}`;
  const s = statsFor(data.events);
  runStats.innerHTML = `
    <span class="stat pass">${s.pass}/${s.total} pass</span>
    ${s.fail ? `<span class="stat fail">${s.fail} fail</span>` : ""}
    ${s.skip ? `<span class="stat">${s.skip} skip</span>` : ""}
  `;
  renderTimeline();
  updatePromptPreview();
}

function renderTimeline() {
  timeline.innerHTML = state.events.map((e, i) => {
    const classes = ["step"];
    if (e.outcome === "failure") classes.push("fail");
    if (e.outcome === "skipped") classes.push("skip");
    if (e.importance === "high" || e.importance === "critical") classes.push("crit");
    if (flagged.has(i)) classes.push("flagged");
    return `<li class="${classes.join(" ")}" data-i="${i}">
      <div class="idx">${String(i + 1).padStart(2, "0")}</div>
      <div>
        <div class="desc">${escape(e.description)}</div>
        <div class="meta">${e.kind} · ${e.outcome}${e.error ? ` · ${escape(e.error)}` : ""}</div>
      </div>
      <div class="ms">${fmtTime(e.startMs)}</div>
    </li>`;
  }).join("");
  timeline.querySelectorAll(".step").forEach((li) => {
    li.addEventListener("click", (ev) => {
      const i = Number(li.getAttribute("data-i"));
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
        if (flagged.has(i)) flagged.delete(i); else flagged.add(i);
        renderTimeline();
        updatePromptPreview();
      } else {
        seekTo(i);
      }
    });
  });
}

function seekTo(i) {
  // Approximate: map raw event time to highlight video by scanning the timeline
  // For MVP we just jump based on proportional mapping of event order into video duration.
  if (!player.duration || !isFinite(player.duration)) return;
  const n = state.events.length;
  const chunk = player.duration / (n + 2); // +title +summary
  player.currentTime = Math.max(0, Math.min(player.duration - 0.1, chunk * (i + 1)));
  player.play();
  timeline.querySelectorAll(".step").forEach((li) => li.classList.toggle("active", Number(li.getAttribute("data-i")) === i));
}

function buildPrompt() {
  const stepsText = state.events.map((e, i) => {
    const marker = flagged.has(i) ? "🚩" : e.outcome === "failure" ? "❌" : e.outcome === "skipped" ? "·" : "✓";
    return `  ${marker} [${String(i + 1).padStart(2, "0")} · ${fmtTime(e.startMs)}] ${e.description}${e.error ? `  — ${e.error}` : ""}`;
  }).join("\n");
  const note = (feedbackNote.value || "").trim();
  const header = `Review of ${state.plan?.name ?? "feature"} at ${state.plan?.startUrl ?? ""}`;
  const flaggedList = Array.from(flagged).sort((a, b) => a - b).map((i) => `  - step ${i + 1}: ${state.events[i].description}${state.events[i].error ? ` (error: ${state.events[i].error})` : ""}`).join("\n");
  return [
    header,
    "",
    "Test events:",
    stepsText,
    flagged.size ? `\nFlagged for your attention:\n${flaggedList}` : "",
    note ? `\nMy feedback:\n${note}` : "",
    "",
    "Please investigate and propose a fix.",
  ].join("\n");
}

function updatePromptPreview() {
  promptPreview.textContent = buildPrompt();
}

feedbackNote.addEventListener("input", updatePromptPreview);

copyPromptBtn.addEventListener("click", async () => {
  const text = buildPrompt();
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = "Copied.";
  } catch {
    copyStatus.textContent = "Copy failed — select and copy from preview.";
  }
  setTimeout(() => (copyStatus.textContent = ""), 2500);
});

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadRuns();
