"use strict";

/* ================================================================== */
/*  STRUCTURED OUTLINE                                                 */
/*  Chapter lines are the book's real chapters. Section notes become   */
/*  grayed "ghost" paragraphs in the manuscript                       */
/* ================================================================== */

const secLetter = (i) => String.fromCharCode(65 + (i % 26));

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
      const words = countWords(chapterText(chId));
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
        switchTab("manuscript");
        focusChapter(chId);
      };
      card.querySelectorAll("[data-story-field]").forEach((field) => {
        const save = () => {
          entry[field.dataset.storyField] = field.value.trim();
          if (field.dataset.storyField === "beat" && !entry.beat) entry.beat = "Unassigned";
          if (field.dataset.storyField === "progress" && !entry.progress) entry.progress = "Planned";
          scheduleMetaSave();
          if (field.dataset.storyField === "act") renderOutline();
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

function renderOutline(focusTarget) {
  book.sectionNotes = book.sectionNotes || {};
  book.chapterNotes = book.chapterNotes || {};
  const wrap = $("#outline-list");
  wrap.innerHTML = "";
  if (pluginEnabled("storyMap")) {
    renderStoryMap(wrap);
  }

  book.chapterOrder.forEach((chId, i) => {
    wrap.appendChild(
      outlineLine(
        "chapter",
        chId,
        null,
        i,
        String(i + 1),
        book.chapterNotes[chId] || "",
      ),
    );
    (book.sectionNotes[chId] || []).forEach((sec, j) => {
      wrap.appendChild(
        outlineLine("section", chId, sec.id, j, secLetter(j), sec.text),
      );
    });
  });

  const hint = document.createElement("div");
  hint.className = "ol-hint";
  hint.textContent =
    "Enter — new chapter (or section, from a section line) · Tab — turn a fresh chapter line into a section · Shift+Tab — turn a section into a chapter · Backspace on an empty line removes it";
  wrap.appendChild(hint);

  if (focusTarget) {
    const el = wrap.querySelector(
      focusTarget.secId
        ? `.ol-line[data-sec-id="${focusTarget.secId}"] .ol-text`
        : `.ol-line.ol-chapter[data-ch-id="${focusTarget.chId}"] .ol-text`,
    );
    if (el) {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  }
}

function outlineLine(kind, chId, secId, index, label, text) {
  const line = document.createElement("div");
  line.className = "ol-line ol-" + kind;
  line.dataset.chId = chId;
  if (secId) line.dataset.secId = secId;
  const num = document.createElement("span");
  num.className = "ol-num";
  num.textContent = label;
  const txt = document.createElement("div");
  txt.className = "ol-text";
  txt.contentEditable = "true";
  txt.spellcheck = false;
  txt.textContent = text;

  const save = () => {
    const val = txt.textContent.trim();
    if (kind === "chapter") {
      book.chapterNotes[chId] = val;
    } else {
      const sec = (book.sectionNotes[chId] || []).find((s) => s.id === secId);
      if (sec) sec.text = val;
    }
    scheduleMetaSave();
  };

  txt.addEventListener("blur", () => {
    save();
    if (kind === "section") syncGhosts(chId);
    renderNav();
  });

  txt.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
      if (kind === "chapter") {
        const at = book.chapterOrder.indexOf(chId) + 1;
        const newId = createChapterAt(at);
        renderOutline({ chId: newId });
      } else {
        const list = book.sectionNotes[chId];
        const newSec = { id: "sec-" + Date.now().toString(36), text: "" };
        list.splice(index + 1, 0, newSec);
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ secId: newSec.id });
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const lines = [...document.querySelectorAll(".ol-line .ol-text")];
      const next = lines[lines.indexOf(txt) + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        next.focus();
        const r = document.createRange();
        r.selectNodeContents(next);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      if (kind !== "chapter") return;
      const pos = book.chapterOrder.indexOf(chId);
      if (pos === 0) {
        toast("The first line has to be a chapter");
        return;
      }
      if (countWords(chapterText(chId)) > 0) {
        toast(
          "This chapter already has words in it — only empty chapter lines can become sections",
        );
        return;
      }
      save();
      const prevCh = book.chapterOrder[pos - 1];
      book.sectionNotes[prevCh] = book.sectionNotes[prevCh] || [];
      const newSec = {
        id: "sec-" + Date.now().toString(36),
        text: txt.textContent.trim(),
      };
      book.sectionNotes[prevCh].push(newSec);
      deleteChapterQuiet(chId).then(() => {
        syncGhosts(prevCh);
        renderOutline({ secId: newSec.id });
      });
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (kind !== "section") return;
      save();
      const list = book.sectionNotes[chId];
      const sec = list.find((s) => s.id === secId);
      list.splice(list.indexOf(sec), 1);
      const at = book.chapterOrder.indexOf(chId) + 1;
      const newId = createChapterAt(at);
      book.chapterNotes[newId] = sec.text;
      scheduleMetaSave();
      syncGhosts(chId);
      renderOutline({ chId: newId });
    }
    if (e.key === "Backspace" && txt.textContent.trim() === "") {
      e.preventDefault();
      if (kind === "section") {
        const list = book.sectionNotes[chId];
        book.sectionNotes[chId] = list.filter((s) => s.id !== secId);
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ chId });
      } else if (
        book.chapterOrder.length > 1 &&
        countWords(chapterText(chId)) === 0
      ) {
        const pos = book.chapterOrder.indexOf(chId);
        const prevCh = book.chapterOrder[Math.max(0, pos - 1)];
        deleteChapterQuiet(chId).then(() => renderOutline({ chId: prevCh }));
      }
    }
    e.stopPropagation();
  });

  // right-click any outline line to delete it
  line.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (kind === "chapter") {
      const i = book.chapterOrder.indexOf(chId);
      const words = countWords(chapterText(chId));
      const choice = await optionModal(
        `Chapter ${i + 1}`,
        words ? `${words.toLocaleString()} words.` : "This chapter is empty.",
        [
          {
            label: "Delete chapter",
            desc: words
              ? "Its words move to Darlings, recoverable anytime."
              : "Nothing to save — it just goes.",
            danger: true,
            value: "delete",
          },
        ],
      );
      if (choice === "delete") {
        await deleteChapterToDarlings(chId);
        renderOutline();
      }
    } else {
      const choice = await optionModal("Delete this section?", null, [
        {
          label: "Delete section",
          desc: "Removes the outline line and its gray ghost from the manuscript. Written prose is never touched.",
          danger: true,
          value: "delete",
        },
      ]);
      if (choice === "delete") {
        book.sectionNotes[chId] = (book.sectionNotes[chId] || []).filter(
          (s) => s.id !== secId,
        );
        scheduleMetaSave();
        syncGhosts(chId);
        renderOutline({ chId });
      }
    }
  });

  line.appendChild(num);
  if (kind === "chapter") {
    // A chapter line carries its title above the note: the same title the
    // manuscript heading shows (a safer take on hughhowey/neo#22 — titles
    // and outline notes stay separate things, and edits flow both ways).
    const col = document.createElement("div");
    col.className = "ol-col";
    const title = document.createElement("div");
    title.className = "ol-title";
    title.contentEditable = "true";
    title.spellcheck = false;
    title.textContent = (book.chapterTitles || {})[chId] || "";
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey)) {
        e.preventDefault();
        txt.focus();
      }
      e.stopPropagation();
    });
    title.addEventListener("blur", () => {
      const val = title.textContent.trim();
      book.chapterTitles = book.chapterTitles || {};
      if ((book.chapterTitles[chId] || "") === val) return;
      if (val) book.chapterTitles[chId] = val;
      else delete book.chapterTitles[chId];
      const span = document.querySelector(`.chapter[data-id="${chId}"] .ch-title`);
      if (span) span.textContent = val;
      scheduleMetaSave();
      renderNav();
    });
    col.appendChild(title);
    col.appendChild(txt);
    line.appendChild(col);
    return line;
  }
  line.appendChild(txt);
  return line;
}

// Push section notes into the manuscript as gray ghost paragraphs,
// with real *** scene breaks between sections.
// Once a ghost has been written over, it goes away.
function syncGhosts(chId) {
  const body = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  if (!body) return;
  const list = (book.sectionNotes && book.sectionNotes[chId]) || [];
  const keep = new Set(list.map((s) => s.id));

  const breakFor = (secId) =>
    body.querySelector(`p.scene-break[data-sec-brk="${secId}"]`);

  // 1. Sections deleted from the outline: remove their ghost + its break
  //    (but never touch paragraphs that have been written over)
  body.querySelectorAll("p.ghost[data-sec-id]").forEach((p) => {
    if (!keep.has(p.dataset.secId)) {
      const brk = breakFor(p.dataset.secId);
      if (brk) brk.remove();
      p.remove();
    }
  });

  // 2. Pull all still-ghost paragraphs out, then re-append in outline order
  //    so the ghosts always mirror the outline's sequence
  for (const p of [...body.querySelectorAll("p.ghost[data-sec-id]")]) {
    const brk = breakFor(p.dataset.secId);
    if (brk) brk.remove();
    p.remove();
  }
  for (const sec of list) {
    // written over already? Leave it alone
    const written = body.querySelector(
      `p[data-sec-id="${sec.id}"]:not(.ghost)`,
    );
    if (written) continue;
    if (!sec.text) continue;
    // *** between this ghost and whatever comes before it
    const hasContent = body.innerText.trim() !== "";
    if (
      hasContent &&
      !(
        body.lastElementChild &&
        body.lastElementChild.classList.contains("scene-break")
      )
    ) {
      const brk = document.createElement("p");
      brk.className = "scene-break";
      brk.dataset.secBrk = sec.id;
      brk.textContent = "***";
      body.appendChild(brk);
    }
    const p = document.createElement("p");
    p.className = "ghost";
    p.dataset.secId = sec.id;
    p.textContent = sec.text;
    body.appendChild(p);
  }
  syncChapter(body, chId);
}

let auxDirty = false;
$("#aux-editor").addEventListener("keydown", (e) => {
  styleKeepScroll(e);
});
$("#aux-editor").addEventListener("input", () => {
  auxDirty = true;
  scheduleAuxSave();
  if (spellOn) {
    const key = "aux-" + ($("#aux-editor").dataset.kind || "notes");
    scheduleSpellRescan(key, $("#aux-editor"));
  }
});
// notes paste arrives clean, same as the manuscript
$("#aux-editor").addEventListener("paste", (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData("text/html");
  const text = e.clipboardData.getData("text/plain");
  if (html) document.execCommand("insertHTML", false, cleanPasteHtml(html));
  else if (text)
    document.execCommand("insertText", false, text.replace(/\r/g, ""));
});
function scheduleAuxSave() {
  clearTimeout(saveTimers.aux);
  saveTimers.aux = setTimeout(flushAux, 800);
  scheduleCheckpoint("writing");
}
function flushAux() {
  if (!auxDirty || !book) return;
  const kind = $("#aux-editor").dataset.kind;
  if (kind) window.neo.writeAux(book.id, kind, $("#aux-editor").innerHTML);
  auxDirty = false;
}

function saveNoteCards() {
  if (book) window.neo.writeJSON(book.id, "note-cards", noteCards);
}
function renderNoteCards() {
  const wrap = $("#cards-list");
  wrap.innerHTML = "";
  const add = document.createElement("button");
  add.className = "add-card";
  add.textContent = "+ New card";
  add.onclick = () => {
    noteCards.unshift({ id: "card-" + Date.now().toString(36), title: "", body: "" });
    saveNoteCards();
    renderNoteCards();
    wrap.querySelector(".note-card-title")?.focus();
  };
  wrap.appendChild(add);
  if (!noteCards.length) {
    const empty = document.createElement("div");
    empty.className = "cards-empty";
    empty.textContent = "Make a card for a character, a bit of research, or the next scene. These stay with this book.";
    wrap.appendChild(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "cards-grid";
  let draggingId = null;
  noteCards.forEach((card) => {
    const el = document.createElement("article");
    el.className = "note-card";
    const grip = document.createElement("button");
    grip.className = "card-drag"; grip.textContent = "⠿"; grip.title = "Drag to rearrange"; grip.draggable = true;
    const title = document.createElement("div");
    title.className = "note-card-title"; title.contentEditable = "true"; title.spellcheck = false; title.dataset.ph = "Card title…"; title.textContent = card.title || "";
    const body = document.createElement("div");
    body.className = "note-card-body"; body.contentEditable = "true"; body.spellcheck = true; body.dataset.ph = "Write on this card…"; body.textContent = card.body || "";
    const remove = document.createElement("button");
    remove.className = "note-card-remove"; remove.textContent = "Remove";
    const save = () => { card.title = title.textContent.trim(); card.body = body.textContent; saveNoteCards(); };
    title.oninput = save; body.oninput = save;
    remove.onclick = () => { noteCards = noteCards.filter((c) => c.id !== card.id); saveNoteCards(); renderNoteCards(); };
    grip.addEventListener("dragstart", (e) => { draggingId = card.id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.id); el.classList.add("dragging"); });
    grip.addEventListener("dragend", () => { draggingId = null; el.classList.remove("dragging"); grid.querySelectorAll(".drop-before").forEach((n) => n.classList.remove("drop-before")); });
    el.addEventListener("dragover", (e) => { if (!draggingId || draggingId === card.id) return; e.preventDefault(); el.classList.add("drop-before"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before"));
    el.addEventListener("drop", (e) => {
      if (!draggingId || draggingId === card.id) return;
      e.preventDefault();
      const from = noteCards.findIndex((c) => c.id === draggingId);
      const to = noteCards.findIndex((c) => c.id === card.id);
      if (from < 0 || to < 0) return;
      const [moved] = noteCards.splice(from, 1);
      noteCards.splice(to > from ? to - 1 : to, 0, moved);
      saveNoteCards(); renderNoteCards();
    });
    el.append(grip, title, body, remove); grid.appendChild(el);
  });
  wrap.appendChild(grid);
}

function renderDarlings() {
  const wrap = $("#darlings-list");
  wrap.innerHTML = "";
  if (darlings.length === 0) {
    wrap.innerHTML = `<div class="darlings-empty">When a beautiful paragraph is gumming up the works, select it and drag it onto the Darlings tab below.<br>It leaves your manuscript but it is never lost.</div>`;
    return;
  }
  for (const d of darlings) {
    const el = document.createElement("div");
    el.className = "darling";
    const content = document.createElement("div");
    if (d.html) content.innerHTML = d.html;
    else content.textContent = d.text;
    const meta = document.createElement("div");
    meta.className = "d-meta";
    const when = new Date(d.date).toLocaleDateString();
    meta.innerHTML = `<span>from ${d.chapterLabel} · ${when} · ${countWords(d.text).toLocaleString()} words</span>
      <span><button class="d-restore">Restore</button> <button class="d-del">Delete forever</button></span>`;
    meta.querySelector(".d-restore").onclick = () => restoreDarling(d.id);
    meta.querySelector(".d-del").onclick = async () => {
      snapshotStructure("darling delete");
      // tidy up the invisible anchor the darling left behind
      const anchor = document.querySelector(
        `.darling-anchor[data-did="${d.id}"]`,
      );
      if (anchor) {
        const body = anchor.closest(".chapter-body");
        const chId = anchor.closest(".chapter").dataset.id;
        anchor.remove();
        syncChapter(body, chId);
      }
      darlings = darlings.filter((x) => x.id !== d.id);
      await window.neo.writeJSON(book.id, "darlings", darlings);
      renderDarlings();
    };
    el.appendChild(content);
    el.appendChild(meta);
    wrap.appendChild(el);
  }
}

async function restoreDarling(id) {
  const d = darlings.find((x) => x.id === id);
  if (!d) return;
  snapshotStructure("darling restore");
  switchTab("manuscript");

  // Preferred: put it back in the exact spot it was cut from, located by
  // the remembered text surrounding the cut point
  if (d.chapterId && book.chapterOrder.includes(d.chapterId)) {
    const body = document.querySelector(
      `.chapter[data-id="${d.chapterId}"] .chapter-body`,
    );
    const pos = body ? findDarlingPosition(body, d) : -1;
    if (body && pos !== -1) {
      const at = textPosToRange(body, pos);
      if (at) {
        let scrollTo = at.startContainer.parentElement?.closest?.("p") || body;
        if (d.html && /<p[\s>]/i.test(d.html)) {
          // block content: paragraphs go back in after the host paragraph
          const holder = document.createElement("div");
          holder.innerHTML = d.html;
          let ref = scrollTo === body ? body.lastElementChild : scrollTo;
          scrollTo = holder.firstElementChild || scrollTo;
          for (const n of [...holder.childNodes]) {
            ref.after(n);
            ref = n;
          }
        } else {
          // inline content: slot it right where the caret was
          at.insertNode(
            document.createRange().createContextualFragment(d.html || d.text),
          );
        }
        syncChapter(body, d.chapterId);
        darlings = darlings.filter((x) => x.id !== id);
        await window.neo.writeJSON(book.id, "darlings", darlings);
        scrollTo.scrollIntoView({ behavior: "smooth", block: "center" });
        toast("Darling restored to its original spot");
        return;
      }
    }
  }

  // Fallback: the spot no longer exists — end of its chapter (or the last one)
  let chId =
    d.chapterId && book.chapterOrder.includes(d.chapterId)
      ? d.chapterId
      : book.chapterOrder[book.chapterOrder.length - 1];
  if (!chId) {
    newChapter();
    chId = book.chapterOrder[0];
  }
  const body = document.querySelector(
    `.chapter[data-id="${chId}"] .chapter-body`,
  );
  const frag = d.html
    ? d.html
    : "<p>" + d.text.replace(/\n+/g, "</p><p>") + "</p>";
  body.insertAdjacentHTML("beforeend", frag);
  chapterHTML[chId] = captureBody(body);
  scheduleChapterSave(chId);
  darlings = darlings.filter((x) => x.id !== id);
  await window.neo.writeJSON(book.id, "darlings", darlings);
  focusChapter(chId);
  toast(
    "Original spot is gone — restored to the end of " +
      (d.chapterLabel || "the manuscript"),
  );
}
