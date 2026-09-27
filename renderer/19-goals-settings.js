"use strict";

/* ================================================================== */
/*  GOALS, SPRINTS, AND THE CHART                                      */
/* ================================================================== */

function goalPace(total = bookWordCount(), subject = book) {
  const goal = subject.wordGoal || 0;
  const due = subject.goalDueDate
    ? new Date(`${subject.goalDueDate}T12:00:00`)
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

function statsChartSvg(subject = book, dailyTarget = effectiveDailyTarget()) {
  const W = 520, H = 170, PAD = 6;
  const days = [];
  for (let i = 29; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(writingDay(d)); }
  const daily = days.map((d) => Math.max(0, dailyWords(d)));
  const cumulative = cumulativeWordSeries(days);
  const goal = subject.wordGoal || 0;
  const mode = subject.goalChartMode || "daily";
  const maxD = Math.max(...daily, dailyTarget, 1);
  let maxC = Math.max(...cumulative, goal, 1);
  const bw = (W - PAD * 2) / 30;
  const due = subject.goalDueDate ? new Date(`${subject.goalDueDate}T12:00:00`) : null;
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
    return `<rect class="stats-bar" x="${(PAD + i * bw).toFixed(1)}" y="${H - PAD - h}" width="${(bw - 2).toFixed(1)}" height="${h}" rx="1.5" fill="var(--accent)" opacity="0.55" tabindex="0" data-label="${label}" data-words="${v.toLocaleString()}" aria-label="${label}: ${v.toLocaleString()} words"></rect>`;
  }).join("") : "";
  const line = mode === "cumulative" ? cumulative.map((v, i) => {
    const x = (PAD + i * bw + bw / 2).toFixed(1);
    const y = (H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1);
    return (i === 0 ? "M" : "L") + x + "," + y;
  }).join(" ") : "";
  const paceLine = planned ? `<path d="${planned.map((v, i) => `${i === 0 ? "M" : "L"}${(PAD + i * bw + bw / 2).toFixed(1)},${(H - PAD - (v / maxC) * (H - PAD * 2 - 20)).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--muted)" stroke-dasharray="4,4" stroke-width="1.5"/>` : "";
  const goalLine = mode === "daily" && dailyTarget
    ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (dailyTarget / maxD) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="var(--accent)" stroke-dasharray="5,4" stroke-width="1.5"/>`
    : mode === "cumulative" && goal ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" y2="${(H - PAD - (goal / maxC) * (H - PAD * 2 - 20)).toFixed(1)}" stroke="var(--accent)" stroke-dasharray="5,4" stroke-width="1.5"/>` : "";
  const axisLabels = mode === "daily" ? `<text x="8" y="18" fill="var(--ui-text-soft)" font-size="10">${maxD.toLocaleString()}</text><text x="8" y="${H - 10}" fill="var(--muted)" font-size="10">0</text>` : `<text x="8" y="18" fill="var(--ui-text-soft)" font-size="10">${maxC.toLocaleString()}</text><text x="8" y="${H - 10}" fill="var(--muted)" font-size="10">0</text>`;
  return `<svg id="stats-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${axisLabels}${bars}<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${paceLine}${goalLine}<g class="chart-tooltip" hidden><rect rx="3" fill="var(--surface-raised)" stroke="var(--accent)" stroke-width="0.7"></rect><text fill="var(--ui-text)" font-size="11" text-anchor="middle"></text></g></svg>
  <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);padding:2px 4px"><span>30 days ago</span><span style="color:var(--accent)">▮ daily words</span><span style="color:var(--accent)">${mode === "daily" ? "- - daily target" : "— total · - - goal"}${planned ? " · pace" : ""}</span><span>today</span></div>`;
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

function statsOverview(subject = book, dailyTarget = library.dailyGoal || 0) {
  const wordsToday = dailyWords(todayStr());
  const total = bookWordCount();
  const pace = goalPace(total, subject);
  return `
    <div class="stats-nums">
      <div><div class="big">${total.toLocaleString()}</div><div class="lbl">total words</div></div>
      <div><div class="big">${wordsToday.toLocaleString()}</div><div class="lbl">today</div></div>
      <div><div class="big">${subject.wordGoal ? Math.min(100, Math.round((total / subject.wordGoal) * 100)) + "%" : "—"}</div><div class="lbl">of manuscript goal</div></div>
    </div>
    ${pace ? `<div class="stats-pace"><span class="pace-item"><strong>${pace.daily.toLocaleString()}</strong> / day</span><span class="pace-item"><strong>${pace.weekly.toLocaleString()}</strong> / week</span><span class="pace-item">to finish ${pace.remaining.toLocaleString()} words by ${pace.due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>` : ""}
    ${statsChartSvg(subject, pace ? pace.daily : dailyTarget)}`;
}

function deadlinePaceText(subject = book) {
  const pace = goalPace(bookWordCount(), subject);
  return pace
    ? `Deadline pace: <strong>${pace.daily.toLocaleString()} words/day</strong> · ${pace.weekly.toLocaleString()} words/week`
    : "";
}



function openStats() {
  const hasBook = !!book;
  const target = book;
  const draft = hasBook ? { ...book } : null;
  let daily = library.dailyGoal || 0, saving = false;
  const { bd, close } = settingsDialog({
    title: 'Progress & goals', scope: hasBook ? `This book · ${book.title}` : 'Entire library', className: 'stats-modal', canClose: () => !saving,
    content: `<div id="stats-overview">${hasBook ? statsOverview(draft, daily) : ''}</div>
      <section class="stats-section"><h3>Targets</h3>
      ${hasBook ? `<div class="stats-target-toggle"><button data-chart-mode="daily" class="${(draft.goalChartMode || 'daily') === 'daily' ? 'active' : ''}">Daily words</button><button data-chart-mode="cumulative" class="${draft.goalChartMode === 'cumulative' ? 'active' : ''}">Total words</button></div>` : ''}
      <div class="stats-row"><label>Daily target · entire library<input id="st-daily" type="number" min="0" value="${daily || ''}" placeholder="500"/></label>
      ${hasBook ? `<label>Manuscript target<input id="st-book" type="number" min="0" value="${draft.wordGoal || ''}" placeholder="80000"/></label><label>Deadline<input id="st-due" type="date" value="${draft.goalDueDate || ''}"/></label>` : ''}</div>
      ${hasBook ? `<div id="deadline-pace" class="deadline-pace">${deadlinePaceText(draft)}</div>` : ''}</section>
      <div data-plugin-settings></div><p class="dialog-error" role="status"></p>`,
    actions: '<button class="m-cancel btn-quiet">Cancel</button><button class="m-ok btn-gold">Save goals</button>'
  });
  const preview = () => {
    daily = Math.max(0, parseInt(bd.querySelector('#st-daily').value, 10) || 0);
    if (!hasBook) return;
    draft.wordGoal = Math.max(0, parseInt(bd.querySelector('#st-book').value, 10) || 0);
    draft.goalDueDate = bd.querySelector('#st-due').value || '';
    bd.querySelector('#stats-overview').innerHTML = statsOverview(draft, daily);
    bd.querySelector('#deadline-pace').innerHTML = deadlinePaceText(draft);
    bindStatsChart(bd);
  };
  bd.querySelectorAll('input').forEach(input => input.addEventListener('input', preview));
  bd.querySelectorAll('[data-chart-mode]').forEach(button => {
    button.onclick = () => { draft.goalChartMode = button.dataset.chartMode; bd.querySelectorAll('[data-chart-mode]').forEach(b => b.classList.toggle('active', b === button)); preview(); };
  });
  const save = async () => {
    if (saving) return;
    preview(); saving = true; bd.querySelector('.m-ok').disabled = true;
    try {
      await window.neo.writeLibrary({ ...library, dailyGoal: daily });
      library.dailyGoal = daily;
      if (hasBook) {
        Object.assign(target, { wordGoal: draft.wordGoal, goalDueDate: draft.goalDueDate, goalChartMode: draft.goalChartMode || 'daily' });
        scheduleMetaSave(); updateCounters();
      }
      saving = false; close();
    } catch (err) { bd.querySelector('[role="status"]').textContent = ipcErrorText(err, 'Could not save goals').text; }
    finally { saving = false; bd.querySelector('.m-ok').disabled = false; }
  };
  bd.querySelector('.m-ok').onclick = save;
  bd.querySelector('.m-cancel').onclick = close;
  if (hasBook) bindStatsChart(bd);
  NeoPlugins.notify('settings', bd, save);
}

$('#goal-counter').onclick = openStats;
