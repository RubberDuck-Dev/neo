"use strict";

/* ================================================================== */
/*  COUNTERS                                                           */
/* ================================================================== */

function bookWordCount() {
  return book.chapterOrder.reduce((sum, chId) => sum + chapterWords(chId), 0);
}

function updateCounters() {
  if (!book) return;
  const total = bookWordCount();
  const wc = $("#word-counter");
  if (wordMode === "book") {
    wc.textContent = total.toLocaleString() + " words";
  } else {
    const n = currentChapterId ? chapterWords(currentChapterId) : 0;
    const idx = book.chapterOrder.indexOf(currentChapterId);
    wc.textContent = `ch. ${idx + 1}: ${n.toLocaleString()} words`;
  }
  const pos = $("#pos-counter");
  const idx = book.chapterOrder.indexOf(currentChapterId);
  pos.textContent =
    book.chapterOrder.length <= 1
      ? "" // a chapterless story needs no chapter locator
      : idx >= 0
        ? `chapter ${idx + 1} of ${book.chapterOrder.length}`
        : `${book.chapterOrder.length} chapters`;
  // cache for the bookshelf progress bar
  if (book.wordCount !== total) {
    book.wordCount = total;
    scheduleMetaSave();
  }
  trackDailyWords(total);
}

// ---- daily word tracking + goal display ----
// The writing day follows the writer's own clock, and rolls over at
// library.dayEndsAt (0 = midnight) so a session that runs past midnight
// still counts toward the night it began.
function writingDay(d = new Date(), dayEndsAt = library.dayEndsAt || 0) {
  d = new Date(d);
  if (d.getHours() < dayEndsAt) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayStr = () => writingDay();

function setWritingDayEnd(hour) {
  if (!book) { library.dayEndsAt = hour; return; }
  const hasLedger = (book.wordHistory || []).length > 1;
  const oldDay = todayStr();
  library.dayEndsAt = hour;
  const newDay = todayStr();
  // Older books have no timestamps, so retain the old best-effort behavior.
  // New books derive every day from timestamped snapshots instead.
  if (!hasLedger && oldDay !== newDay && book.dailyCounts && book.dailyCounts[oldDay]) {
    book.dailyCounts[newDay] = book.dailyCounts[oldDay];
    delete book.dailyCounts[oldDay];
    scheduleMetaSave();
  }
}

function recordWordEvent(total) {
  const events = book.wordHistory || (book.wordHistory = []);
  const now = Date.now();
  const last = events[events.length - 1];
  if (!last) {
    events.push({ at: now, total });
  } else if (last.total !== total) {
    // One local checkpoint per minute keeps the file tiny while still making
    // cutoff changes accurate to the minute, across app restarts.
    if (now - last.at < 60000) {
      last.at = now;
      last.total = total;
    } else {
      events.push({ at: now, total });
    }
  } else return;
  scheduleMetaSave();
}

function dailyWordMap(dayEndsAt = library.dayEndsAt || 0) {
  const events = book.wordHistory || [];
  if (events.length > 1) {
    const words = {};
    for (let i = 1; i < events.length; i++) {
      const key = writingDay(events[i].at, dayEndsAt);
      words[key] = (words[key] || 0) + events[i].total - events[i - 1].total;
    }
    return words;
  }
  const legacy = book.dailyCounts || {};
  return Object.fromEntries(Object.entries(legacy).map(([day, count]) => [day, (count.end || 0) - (count.start || 0)]));
}

function dailyWords(day) {
  return dailyWordMap()[day] || 0;
}

function cumulativeWordSeries(days) {
  const events = book.wordHistory || [];
  if (events.length > 1) {
    const ends = {};
    for (const event of events) ends[writingDay(event.at)] = event.total;
    let total = events[0].total;
    return days.map((day) => {
      if (typeof ends[day] === "number") total = ends[day];
      return total;
    });
  }
  const counts = book.dailyCounts || {};
  let total = 0;
  const first = days.find((day) => counts[day]);
  if (first) total = counts[first].start || 0;
  return days.map((day) => {
    if (counts[day]) total = counts[day].end || total;
    return total;
  });
}

function trackDailyWords(total) {
  recordWordEvent(total);
  // Keep the legacy summary current for books that may be opened by an older
  // NEO build. The live footer/chart themselves use the timestamped ledger.
  book.dailyCounts = book.dailyCounts || {};
  const today = todayStr();
  if (!book.dailyCounts[today]) {
    book.dailyCounts[today] = { start: total, end: total };
    scheduleMetaSave();
  } else if (book.dailyCounts[today].end !== total) {
    book.dailyCounts[today].end = total;
  }
  const wordsToday = dailyWords(today);
  const gc = $("#goal-counter");
  if (!NeoPlugins.render("counter", total)) {
    const goal = effectiveDailyTarget(total);
    gc.textContent = goal
      ? `${wordsToday.toLocaleString()} / ${goal.toLocaleString()} today`
      : `${wordsToday.toLocaleString()} today`;
    gc.classList.toggle("goal-met", goal > 0 && wordsToday >= goal);
  }
}

$("#word-counter").onclick = () => {
  wordMode = wordMode === "book" ? "chapter" : "book";
  updateCounters();
};

// select a passage → the counter reports its size
document.addEventListener("selectionchange", () => {
  if (!book || currentTab !== "manuscript") return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    let el = sel.anchorNode;
    if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (el && el.closest && el.closest(".chapter-body")) {
      const n = countWords(sel.toString());
      if (n > 0) {
        $("#word-counter").textContent = n.toLocaleString() + " selected";
        return;
      }
    }
  }
  clearTimeout(saveTimers.selcount);
  saveTimers.selcount = setTimeout(() => {
    if (book) updateCounters();
  }, 150);
});

// track which chapter you're scrolled to
$("#paper-scroll").addEventListener("scroll", () => {
  clearTimeout(saveTimers.scroll);
  saveTimers.scroll = setTimeout(() => {
    const mid = window.innerHeight * 0.4;
    let best = null;
    for (const sec of $$(".chapter")) {
      if (sec.getBoundingClientRect().top < mid) best = sec.dataset.id;
    }
    if (best && best !== currentChapterId) {
      currentChapterId = best;
      highlightNav();
      updateCounters();
    }
  }, 120);
});
