"use strict";
NeoPlugins.define("sprints", { name: "Writing Sprints", icon: "⚡", kind: "Writing tool", description: "Race a timer or a word count from Progress & Goals.", bookScoped: true }, (ctx) => {
if (!ctx.hasBook) return {};
const { $, toast } = ctx;
const bookWordCount = ctx.wordCount, updateCounters = ctx.refreshCounters;
let finishTimer;
const controls = ctx.own(document.createElement("span"));
controls.id = "sprint-controls"; controls.hidden = true;
controls.innerHTML = '<button id="sprint-pause" title="Pause timer">⏸</button><button id="sprint-stop" title="Stop timer">⏹</button>';
$("#goal-counter").after(controls);
let sprint = null;
let sprintTimer = null;
let settingsPanel = null;
let settingsClose = null;

function formatDuration(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function finishSprint(message) {
  if (!sprint || sprint.done) return;
  sprint.done = true;
  clearInterval(sprintTimer);
  sprintTimer = null;
  $("#bottombar").classList.add("attn", "sprint-finished");
  finishTimer = setTimeout(
    () => $("#bottombar").classList.remove("attn", "sprint-finished"),
    3400,
  );
  toast(message, 6000);
  updateSprintControls();
  updateCounters();
  if (settingsPanel?.isConnected) renderSprintSettings(settingsPanel, settingsClose);
}

function updateSprintCounter(total = bookWordCount()) {
  if (!sprint || sprint.done) return false;
  if (!ctx.hasBook) { endSprintQuietly(); return false; }
  const gc = $("#goal-counter");
  if (sprint.mode === "timer") {
    if (sprint.paused) {
      gc.textContent = `Paused · ${formatDuration(Math.ceil(sprint.remainingMs / 1000))}`;
      updateSettingsStatus();
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
    updateSettingsStatus();
    return true;
  }
  const words = total - sprint.startCount;
  gc.textContent = `⚡ ${words.toLocaleString()} / ${sprint.target.toLocaleString()}`;
  updateSettingsStatus();
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

function updateSettingsStatus() {
  if (!settingsPanel?.isConnected || !sprint || sprint.done) return;
  const remaining = settingsPanel.querySelector('#st-sprint-remaining');
  if (remaining) remaining.textContent = sprint.mode === 'timer'
    ? formatDuration(Math.ceil((sprint.paused ? sprint.remainingMs : Math.max(0, sprint.endsAt - Date.now())) / 1000))
    : `${Math.max(0, bookWordCount() - sprint.startCount).toLocaleString()} / ${sprint.target.toLocaleString()}`;
  const state = settingsPanel.querySelector('#st-sprint-state');
  if (state) state.textContent = sprint.mode === 'timer' ? (sprint.paused ? 'paused' : 'remaining') : 'words';
  const pause = settingsPanel.querySelector('#st-sprint-pause');
  if (pause) pause.textContent = sprint.paused ? 'Resume' : 'Pause';
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
  updateSettingsStatus();
}

// The plugin was removed (or the pen name changed) mid-sprint: no toast,
// no flash, the counter simply goes back to today's words.
function endSprintQuietly() {
  clearTimeout(finishTimer);
  $("#bottombar").classList.remove("attn", "sprint-finished");
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
  if (settingsPanel?.isConnected) renderSprintSettings(settingsPanel, settingsClose);
}

function stopSprint() {
  if (!sprint || sprint.done) return;
  const got = bookWordCount() - sprint.startCount;
  clearInterval(sprintTimer);
  sprintTimer = null;
  sprint = null;
  updateSprintControls();
  updateCounters();
  if (settingsPanel?.isConnected) renderSprintSettings(settingsPanel, settingsClose);
  toast(`Sprint stopped — ${got.toLocaleString()} words saved.`, 4000);
}


function sprintOptionsHtml() {
  return `<div class="stats-sprint-option"><label>Word sprint <input id="st-sprint-words" type="number" min="50" value="500"/></label><button id="st-word-sprint">Start</button></div>
    <div class="stats-sprint-option stats-sprint-timer"><span class="stats-sprint-label">Timer · minutes</span>
      <div class="stats-sprint-timer-controls"><div class="stats-sprint-time-options" role="group" aria-label="Timer duration">
        ${[10, 20, 30].map(minutes => `<button type="button" class="stats-sprint-time${minutes === 20 ? ' active' : ''}" data-minutes="${minutes}" aria-pressed="${minutes === 20}">${minutes}</button>`).join('')}
        <button type="button" class="stats-sprint-time" data-minutes="custom" aria-pressed="false">Custom</button>
        <label class="stats-sprint-custom" hidden><input id="st-sprint-minutes" type="number" min="1" inputmode="numeric" placeholder="Minutes" aria-label="Custom minutes"/></label>
      </div></div>
      <button id="st-timer-sprint">Start timer</button><p class="stats-sprint-error" role="status" hidden></p>
    </div>`;
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
    if (timer) {
      const choices = [...bd.querySelectorAll('.stats-sprint-time')];
      const custom = bd.querySelector('.stats-sprint-custom');
      const error = bd.querySelector('.stats-sprint-error');
      choices.forEach(choice => choice.onclick = () => {
        choices.forEach(button => {
          const active = button === choice;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', String(active));
        });
        custom.hidden = choice.dataset.minutes !== 'custom';
        error.hidden = true;
        if (!custom.hidden) custom.querySelector('input').focus();
      });
      timer.onclick = () => {
        const selected = bd.querySelector('.stats-sprint-time.active')?.dataset.minutes || '20';
        const minutes = selected === 'custom' ? Number(bd.querySelector('#st-sprint-minutes').value) : Number(selected);
        if (!Number.isInteger(minutes) || minutes < 1) {
          error.textContent = 'Enter a whole number of minutes.';
          error.hidden = false;
          bd.querySelector('#st-sprint-minutes').focus();
          return;
        }
        startSprint("timer", minutes);
        close();
      };
    }
}


function renderSprintSettings(panel, close) {
  const actions = panel.querySelector('#st-sprint-actions');
  if (!actions) return;
  const active = sprint && !sprint.done;
  actions.innerHTML = active
    ? `<div class="stats-sprint-live"><div class="stats-sprint-status"><strong id="st-sprint-remaining"></strong><span id="st-sprint-state"></span></div>${sprint.mode === 'timer' ? '<button id="st-sprint-pause" type="button"></button>' : ''}<button id="st-sprint-end" type="button">Stop</button></div>`
    : sprintOptionsHtml();
  actions.querySelector('#st-sprint-pause')?.addEventListener('click', toggleTimerPause);
  actions.querySelector('#st-sprint-end')?.addEventListener('click', stopSprint);
  if (active) updateSettingsStatus();
  else wireSprintStarts(actions, close);
}

function settings(bd, close) {
  const panel = ctx.own(document.createElement('div'));
  panel.className = 'stats-section';
  panel.innerHTML = '<h3>Writing Sprint</h3><div id="st-sprint-actions" class="stats-sprint-actions"></div>';
  bd.querySelector('[data-plugin-settings]').appendChild(panel);
  settingsPanel = panel;
  settingsClose = close;
  renderSprintSettings(panel, close);
}
ctx.listen($("#sprint-pause"), "click", toggleTimerPause);
ctx.listen($("#sprint-stop"), "click", stopSprint);
return { counter: updateSprintCounter, settings, dispose: endSprintQuietly };
});
