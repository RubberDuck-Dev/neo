"use strict";
NeoPlugins.define("storyMap", { name: "Story Map", icon: "↗", kind: "Planning", description: "Map chapter acts, beats, threads, and progress beside the outline.", bookScoped: true, bookFields: ["storyMap"] }, (ctx) => {
const { escHtml } = ctx;
let book;
const STORY_BEATS = ["Unassigned", "Setup", "Inciting incident", "Rising action", "Midpoint", "Crisis", "Climax", "Resolution"];
const STORY_PROGRESS = ["Planned", "Drafting", "Revising", "Ready"];

function storyMapEntry(chId, index) {
  book.storyMap = book.storyMap || {};
  const existing = book.storyMap[chId] || {};
  const defaultAct = index < Math.ceil(book.chapterOrder.length / 3) ? "Act I" : index < Math.ceil(book.chapterOrder.length * 2 / 3) ? "Act II" : "Act III";
  book.storyMap[chId] = {
    act: existing.act || defaultAct,
    beat: existing.beat || "Unassigned",
    thread: existing.thread || "",
    progress: existing.progress || "Planned",
  };
  return book.storyMap[chId];
}

function renderStoryMap(wrap) {
  book = ctx.bookSnapshot();
  if (!book) return;
  const map = document.createElement("section");
  map.className = "story-map-summary";
  map.innerHTML = `<div class="story-map-head"><div><strong>Story map</strong><span>Shape the book while you outline it.</span></div><span class="story-map-help">Edit any card · click its title to open the chapter</span></div>`;
  const board = document.createElement("div");
  board.className = "story-map-board";
  const groups = new Map();
  book.chapterOrder.forEach((chId, index) => {
    const entry = storyMapEntry(chId, index);
    const act = entry.act || "Unassigned";
    if (!groups.has(act)) groups.set(act, []);
    groups.get(act).push({ chId, index, entry });
  });
  for (const [act, chapters] of groups) {
    const lane = document.createElement("div");
    lane.className = "story-map-lane";
    lane.innerHTML = `<div class="story-map-lane-head"><strong>${escHtml(act)}</strong><span>${chapters.length} chapter${chapters.length === 1 ? "" : "s"}</span></div>`;
    const cards = document.createElement("div");
    cards.className = "story-map-cards";
    chapters.forEach(({ chId, index, entry }) => {
      const words = ctx.chapterWords(chId);
      const scenes = (book.sectionNotes[chId] || []).length;
      const title = (book.chapterTitles || {})[chId] || `Chapter ${index + 1}`;
      const card = document.createElement("article");
      card.className = "story-map-card";
      card.dataset.chId = chId;
      card.innerHTML = `
        <div class="story-map-card-head"><button class="story-map-open" title="Open chapter">${escHtml(title)}</button><span>${words.toLocaleString()} words</span></div>
        <div class="story-map-fields">
          <label>Act <input data-story-field="act" value="${escHtml(entry.act)}" /></label>
          <label>Beat <select data-story-field="beat">${STORY_BEATS.map((beat) => `<option${entry.beat === beat ? " selected" : ""}>${escHtml(beat)}</option>`).join("")}</select></label>
          <label>Progress <select data-story-field="progress">${STORY_PROGRESS.map((progress) => `<option${entry.progress === progress ? " selected" : ""}>${progress}</option>`).join("")}</select></label>
          <label>Thread <input data-story-field="thread" value="${escHtml(entry.thread)}" placeholder="Character or question" /></label>
        </div>
        <div class="story-map-card-foot"><span>${scenes} scene${scenes === 1 ? "" : "s"}</span>${book.chapterNotes[chId] ? `<span title="Outline note">${escHtml(book.chapterNotes[chId].slice(0, 70))}${book.chapterNotes[chId].length > 70 ? "…" : ""}</span>` : "<span>add a chapter note below</span>"}</div>`;
      card.querySelector(".story-map-open").onclick = () => {
        ctx.openChapter(chId);
      };
      card.querySelectorAll("[data-story-field]").forEach((field) => {
        const save = () => {
          entry[field.dataset.storyField] = field.value.trim();
          if (field.dataset.storyField === "beat" && !entry.beat) entry.beat = "Unassigned";
          if (field.dataset.storyField === "progress" && !entry.progress) entry.progress = "Planned";
          ctx.updateBook({ storyMap: book.storyMap });
          if (field.dataset.storyField === "act") ctx.refreshOutline();
          else field.closest(".story-map-card")?.classList.add("saved");
        };
        field.addEventListener("change", save);
        field.addEventListener("blur", save);
        field.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); field.blur(); }
          event.stopPropagation();
        });
      });
      cards.appendChild(card);
    });
    lane.appendChild(cards);
    board.appendChild(lane);
  }
  if (!book.chapterOrder.length) board.innerHTML = '<p class="story-map-empty">Create a chapter below to start mapping the story.</p>';
  map.appendChild(board);
  wrap.appendChild(map);
}

return { outline: renderStoryMap };
});
