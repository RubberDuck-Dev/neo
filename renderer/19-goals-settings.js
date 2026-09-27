"use strict";

/* ================================================================== */
/*  GOALS, SPRINTS, AND THE CHART                                      */
/* ================================================================== */

let sprint = null;
let sprintTimer = null;

function formatDuration(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function goalPace(total = bookWordCount()) {
  const goal = book.wordGoal || 0;
  const due = book.goalDueDate
    ? new Date(`${book.goalDueDate}T12:00:00`)
    : null;
  if (!goal || !due || Number.isNaN(due.valueOf())) return null;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const days = Math.max(1, Math.ceil((due - today) / 86400000) + 1);
  const remaining = Math.max(0, goal - total);
  return {
    days,
    remaining,
    daily: Math.ceil(remaining / days),
    weekly: Math.ceil((remaining / days) * 7),
    due,
  };
}

function effectiveDailyTarget(total = bookWordCount()) {
  const pace = goalPace(total);
  return pace ? pace.daily : library.dailyGoal || 0;
}

function finishSprint(message) {
  if (!sprint || sprint.done) return;
  sprint.done = true;
  clearInterval(sprintTimer);
  sprintTimer = null;
  $("#bottombar").classList.add("attn", "sprint-finished");
  setTimeout(
    () => $("#bottombar").classList.remove("attn", "sprint-finished"),
    3400,
  );
  toast(message, 6000);
  updateSprintControls();
  updateCounters();
}

function updateSprintCounter(total = bookWordCount()) {
  if (!sprint || sprint.done) return false;
  if (!pluginEnabled("sprints")) { endSprintQuietly(); return false; }
  const gc = $("#goal-counter");
  if (sprint.mode === "timer") {
    if (sprint.paused) {
      gc.textContent = `Paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}`;
      return true;
    }
    const seconds = Math.ceil((sprint.endsAt - Date.now()) / 1000);
    if (seconds <= 0) {
      finishSprint(
        "Time — take a breath, then keep the words that are coming.",
      );
      return false;
    }
    gc.textContent = formatDuration(seconds);
    return true;
  }
  const words = total - sprint.startCount;
  gc.textContent = `⚡ ${words.toLocaleString()} / ${sprint.target.toLocaleString()}`;
  if (words >= sprint.target) {
    finishSprint(
      `Sprint complete — ${words.toLocaleString()} words. Well earned.`,
    );
    return false;
  }
  return true;
}

function startSprint(mode, amount) {
  const total = bookWordCount();
  sprint = {
    mode,
    target: mode === "words" ? amount : null,
    startCount: total,
    startTime: Date.now(),
    endsAt: mode === "timer" ? Date.now() + amount * 60000 : null,
    remainingMs: mode === "timer" ? amount * 60000 : null,
    paused: false,
    done: false,
  };
  clearInterval(sprintTimer);
  sprintTimer = setInterval(() => updateSprintCounter(), 1000);
  updateSprintCounter(total);
  updateSprintControls();
  toast(
    mode === "timer"
      ? `${amount}-minute writing timer started.`
      : `Sprint started — ${amount.toLocaleString()} words. Go.`,
  );
}

function updateSprintControls() {
  const controls = $("#sprint-controls");
  if (!controls) return;
  const activeTimer = sprint && !sprint.done && sprint.mode === "timer";
  controls.hidden = !activeTimer;
  if (activeTimer) {
    $("#sprint-pause").textContent = sprint.paused ? "▶" : "⏸";
    $("#sprint-pause").title = sprint.paused ? "Resume timer" : "Pause timer";
  }
}

function toggleTimerPause() {
  if (!sprint || sprint.done || sprint.mode !== "timer") return;
  if (sprint.paused) {
    sprint.endsAt = Date.now() + sprint.remainingMs;
    sprint.paused = false;
    clearInterval(sprintTimer);
    sprintTimer = setInterval(() => updateSprintCounter(), 1000);
  } else {
    sprint.remainingMs = Math.max(0, sprint.endsAt - Date.now());
    sprint.paused = true;
    clearInterval(sprintTimer);
    sprintTimer = null;
  }
  updateSprintControls();
  updateCounters();
}

// The plugin was removed (or the pen name changed) mid-sprint: no toast,
// no flash, the counter simply goes back to today's words.
function endSprintQuietly() {
  if (!sprint) return;
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
}

function stopSprint() {
  if (!sprint || sprint.done) return;
  const got = bookWordCount() - sprint.startCount;
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
  updateCounters();
  toast(`Sprint stopped — ${got.toLocaleString()} words saved.`, 4000);
}

function statsChartSvg() {
  const W = 520, H = 170, PAD = 6;
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(writingDay(d)); }
  const daily = days.map((d) => Math.max(0, dailyWords(d)));
  const cumulative = cumulativeWordSeries(days);
  const goal = book.wordGoal || 0;
  const mode = book.goalChartMode || "daily";
  const dailyTarget = effectiveDailyTarget();
  const maxD = Math.max(...daily, dailyTarget, 1);
  let maxC = Math.max(...cumulative, goal, 1);
  const bw = (W - PAD * 2) / 30;
  const due = book.goalDueDate ? new Date(`${book.goalDueDate}T12:00:00`) : null;
  const firstIndex = daily.findIndex((words) => words !== 0);
  const baseline = firstIndex >= 0 ? cumulative[firstIndex] - daily[firstIndex] : cumulative[0];
  const startDate = new Date(`${days[Math.max(0, firstIndex)]}T12:00:00`);
  const planned = mode === "cumulative" && due && goal && due > startDate
    ? days.map((d) => { const point = new Date(`${d}T12:00:00`); const fraction = Math.max(0, Math.min(1, (point - startDate) / (due - startDate))); return baseline + (goal - baseline) * fraction; })
    : null;
  if (planned) maxC = Math.max(maxC, ...planned);
  const bars = mode === "daily" ? daily.map((v, i) => {
    const h = Math.max(2, Math.round((v / maxD) * (mode === "daily" ? H - PAD * 2 - 20 : H * 0.45)));
    const label = new Date(`${days[i]}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `<rect class="stats-bar" x="${(PAD + i * bw).toFixed(1)}" y="${H - PAD - h}" width="${(bw - 2).toFixed(1)}" height="${h}" rx="1.5" fill="#3d5a4f" tabindex="0" data-label="${label}" data-words="${v.toLocaleString()}" aria-label="${label}: ${v.toLocaleString()} words"></rect>`;
  }).join("") : "";
  const line = mode === "cumulative" ? cumulative.map((v, i) => {
    const x = (PAD + i * bw + bw / 2).toFixed(1);
    const y = (H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1);
    return (i === 0 ? "M" : "L") + x + "," + y;
  }).join(" ") : "";
  const paceLine = planned ? `<path d="${planned.map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * bw + bw / 2).toFixed(1)},${(H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1)}`).join(" ")}" fill="none" stroke="#8d8778" stroke-dasharray="4,4" stroke-width="1.5"/>` : "";
  const goalLine = mode === "daily" && dailyTarget
    ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="#c9a86a" stroke-dasharray="5,4" stroke-width="1.5"/>`
    : mode === "cumulative" && goal ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="#c9a86a" stroke-dasharray="5,4" stroke-width="1.5"/>` : "";
  const axisLabels = mode === "daily" ? `<text x="8" y="18" fill="#aaa" font-size="10">${maxD.toLocaleString()}</text><text x="8" y="${H - 10}" fill="#777" font-size="10">0</text>` : `<text x="8" y="18" fill="#aaa" font-size="10">${maxC.toLocaleString()}</text><text x="8" y="${H - 10}" fill="#777" font-size="10">0</text>`;
  return `<svg id="stats-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${axisLabels}${bars}<path d="${line}" fill="none" stroke="#c9a86a" stroke-width="2"/>${paceLine}${goalLine}<g class="chart-tooltip" hidden><rect rx="3" fill="#292722" stroke="#c9a86a" stroke-width="0.7"></rect><text fill="#eee" font-size="11" text-anchor="middle"></text></g></svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:#666;padding:2px 4px"><span>30 days ago</span><span style="color:#3d8a6a">▮ daily words</span><span style="color:var(--accent)">${mode === "daily" ? "- - daily target" : "— total · - - goal"}${planned ? " · pace" : ""}</span><span>today</span></div>`;
}

function bindStatsChart(root) {
  const svg = root.querySelector("#stats-chart");
  if (!svg) return;
  const tip = svg.querySelector(".chart-tooltip"), text = tip.querySelector("text"), rect = tip.querySelector("rect");
  const show = (bar) => {
    text.textContent = `${bar.dataset.label} · ${bar.dataset.words} words`;
    const box = bar.getBBox(), x = Math.max(60, Math.min(460, box.x + box.width / 2));
    text.setAttribute("x", x); text.setAttribute("y", "22");
    const width = Math.max(104, text.getComputedTextLength() + 16);
    rect.setAttribute("x", x - width / 2); rect.setAttribute("y", "7"); rect.setAttribute("width", width); rect.setAttribute("height", "21");
    tip.removeAttribute("hidden");
  };
  svg.querySelectorAll(".stats-bar").forEach((bar) => { bar.addEventListener("pointerenter", () => show(bar)); bar.addEventListener("focus", () => show(bar)); });
  svg.addEventListener("pointerleave", () => { tip.setAttribute("hidden", ""); });
  svg.addEventListener("focusout", () => { tip.setAttribute("hidden", ""); });
}

function statsOverview() {
  const wordsToday = dailyWords(todayStr());
  const total = bookWordCount();
  const pace = goalPace(total);
  return `
    <div class="stats-nums">
      <div><div class="big">${total.toLocaleString()}</div><div class="lbl">total words</div></div>
      <div><div class="big">${wordsToday.toLocaleString()}</div><div class="lbl">today</div></div>
      <div><div class="big">${book.wordGoal ? Math.min(100, Math.round((total / book.wordGoal) * 100)) + "%" : "—"}</div><div class="lbl">of manuscript goal</div></div>
    </div>
    ${pace ? `<div class="stats-pace"><span class="pace-item"><strong>${pace.daily.toLocaleString()}</strong> / day</span><span class="pace-item"><strong>${pace.weekly.toLocaleString()}</strong> / week</span><span class="pace-item">to finish ${pace.remaining.toLocaleString()} words by ${pace.due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>` : ""}
    ${statsChartSvg()}`;
}

function deadlinePaceText() {
  const pace = goalPace();
  return pace
    ? `Deadline pace: <strong>${pace.daily.toLocaleString()} words/day</strong> · ${pace.weekly.toLocaleString()} words/week`
    : "";
}



function openStats() {
  const hasBook = !!book;
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal stats-modal" style="width:600px">
      <div class="stats-modal-head"><h2 style="font-size:17px">${hasBook ? escHtml(book.title) + " — progress" : "Writing settings"}</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <div id="stats-overview">${hasBook ? statsOverview() : ""}</div>
      <div class="stats-section">
        <h3>${hasBook ? "Targets" : "Writing rhythm"}</h3>
        ${hasBook ? `<div class="stats-target-toggle"><button data-chart-mode="daily" class="${(book.goalChartMode || "daily") === "daily" ? "active" : ""}">Daily words</button><button data-chart-mode="cumulative" class="${(book.goalChartMode || "daily") === "cumulative" ? "active" : ""}">Total words</button></div>` : ""}
        <div class="stats-row">
          <label>Daily target <input id="st-daily" type="number" min="0" value="${library.dailyGoal || ""}" placeholder="500"/></label>
          ${hasBook ? `<label>Manuscript target <input id="st-book" type="number" min="0" value="${book.wordGoal || ""}" placeholder="80000"/></label><label>Deadline <input id="st-due" type="date" value="${book.goalDueDate || ""}"/></label>` : ""}
        </div>
        ${hasBook ? `<div id="deadline-pace" class="deadline-pace">${deadlinePaceText()}</div>` : ""}
      </div>
      <div class="stats-row stats-preferences">
        <label>My writing day ends at
          <select id="st-dayends">
            ${[0, 1, 2, 3, 4, 5, 6].map((h) => `<option value="${h}"${(library.dayEndsAt || 0) === h ? " selected" : ""}>${h ? h + " am" : "midnight"}</option>`).join("")}
          </select>
        </label>
      </div>
      ${
        hasBook && pluginEnabled("sprints")
          ? `
      <div class="stats-section">
        <h3>Writing Sprint</h3>
        <div id="st-sprint-actions" class="stats-sprint-actions">
          ${sprint && !sprint.done ? `<div class="stats-sprint-live"><span class="soft">${sprint.mode === "timer" ? (sprint.paused ? `Timer paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}` : `Timer running · ${formatDuration(Math.ceil((sprint.endsAt - Date.now()) / 1000))}`) : "Word sprint running"}</span>${sprint.mode === "timer" ? `<button id="st-sprint-pause">${sprint.paused ? "Resume" : "Pause"}</button>` : ""}<button id="st-sprint-end">Stop</button></div>` : `<div class="stats-sprint-option"><label>Word sprint <input id="st-sprint-words" type="number" min="50" value="500"/></label><button id="st-word-sprint">Start</button></div><div class="stats-sprint-option"><label>Timer <input id="st-sprint-minutes" type="number" min="1" value="25"/> min</label><button id="st-timer-sprint">Start</button></div>`}
        </div>
      </div>`
          : ""
      }
      ${readAloudSettingsHtml()}
      <div class="stats-section stats-writing-style">
        <h3>New-book starting point</h3>
        <div class="stats-style-choices" role="group" aria-label="New-book starting point">
          <button type="button" data-writing-style="pantser" class="${library.writingStyle !== "plotter" ? "active" : ""}"><strong>Pantser</strong><span>Start on the blank page</span></button>
          <button type="button" data-writing-style="plotter" class="${library.writingStyle === "plotter" ? "active" : ""}"><strong>Plotter</strong><span>Start in the outline</span></button>
        </div>
      </div>
      <div style="text-align:right;margin-top:14px">
        <button class="m-ok btn-gold">Done</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  if (hasBook) bindStatsChart(bd);
  const finishReadAloudSettings = bindReadAloudSettings(bd);
  const refreshStatsPreview = () => {
    if (!hasBook) return;
    library.dailyGoal = parseInt(bd.querySelector("#st-daily").value, 10) || 0;
    book.wordGoal = parseInt(bd.querySelector("#st-book").value, 10) || 0;
    book.goalDueDate = bd.querySelector("#st-due").value || "";
    bd.querySelector("#stats-overview").innerHTML = statsOverview();
    bd.querySelector("#deadline-pace").innerHTML = deadlinePaceText();
    bindStatsChart(bd);
    updateCounters();
  };
  if (hasBook) ["#st-daily", "#st-book", "#st-due"].forEach((sel) => {
    const input = bd.querySelector(sel);
    input.addEventListener("input", refreshStatsPreview);
    input.addEventListener("change", refreshStatsPreview);
  });
  const close = async () => {
    finishReadAloudSettings();
    library.dailyGoal = parseInt(bd.querySelector("#st-daily").value, 10) || 0;
    setWritingDayEnd(parseInt(bd.querySelector("#st-dayends").value, 10) || 0);
    if (hasBook) {
      book.wordGoal = parseInt(bd.querySelector("#st-book").value, 10) || 0;
      book.goalDueDate = bd.querySelector("#st-due").value || "";
      book.goalChartMode = book.goalChartMode || "daily";
      scheduleMetaSave();
    }
    await window.neo.writeLibrary(library);
    bd.remove();
    if (hasBook) updateCounters();
  };
  bd.querySelector(".m-ok").onclick = close;
  bd.querySelector(".m-cancel").onclick = close;
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
  bd.querySelector("#st-dayends").onchange = async () => {
    setWritingDayEnd(parseInt(bd.querySelector("#st-dayends").value, 10) || 0);
    await window.neo.writeLibrary(library);
    if (hasBook) {
      bd.querySelector("#stats-overview").innerHTML = statsOverview();
      bindStatsChart(bd);
      updateCounters();
    }
  };
  if (hasBook) {
    bd.querySelectorAll("[data-chart-mode]").forEach((btn) => {
      btn.onclick = () => {
        book.goalChartMode = btn.dataset.chartMode;
        bd.querySelectorAll("[data-chart-mode]").forEach((b) => b.classList.toggle("active", b === btn));
        bd.querySelector("#stats-overview").innerHTML = statsOverview();
        bindStatsChart(bd);
      };
    });
    const pause = bd.querySelector("#st-sprint-pause");
    if (pause) pause.onclick = () => {
      toggleTimerPause();
      pause.textContent = sprint && sprint.paused ? "Resume" : "Pause";
      const status = bd.querySelector(".stats-sprint-live .soft");
      if (status) status.textContent = sprint && sprint.paused ? `Timer paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}` : `Timer running · ${formatDuration(Math.ceil((sprint.endsAt - Date.now()) / 1000))}`;
    };
    const end = bd.querySelector("#st-sprint-end");
    if (end)
      end.onclick = () => {
        stopSprint();
        bd.querySelector("#st-sprint-actions").innerHTML = sprintOptionsHtml();
        wireSprintStarts(bd, close);
      };
    wireSprintStarts(bd, close);
  }
  bd.querySelectorAll("[data-writing-style]").forEach((choice) => {
    choice.onclick = () => {
      library.writingStyle = choice.dataset.writingStyle;
      bd.querySelectorAll("[data-writing-style]").forEach((button) => button.classList.toggle("active", button === choice));
    };
  });
}

function sprintOptionsHtml() {
  return '<div class="stats-sprint-option"><label>Word sprint <input id="st-sprint-words" type="number" min="50" value="500"/></label><button id="st-word-sprint">Start</button></div><div class="stats-sprint-option"><label>Timer <input id="st-sprint-minutes" type="number" min="1" value="25"/> min</label><button id="st-timer-sprint">Start</button></div>';
}

function wireSprintStarts(bd, close) {
    const word = bd.querySelector("#st-word-sprint");
    if (word)
      word.onclick = () => {
        startSprint(
          "words",
          parseInt(bd.querySelector("#st-sprint-words").value, 10) || 500,
        );
        close();
      };
    const timer = bd.querySelector("#st-timer-sprint");
    if (timer)
      timer.onclick = () => {
        startSprint(
          "timer",
          parseInt(bd.querySelector("#st-sprint-minutes").value, 10) || 25,
        );
        close();
      };
}

$("#goal-counter").onclick = openStats;
$("#sprint-pause").onclick = toggleTimerPause;
$("#sprint-stop").onclick = stopSprint;
