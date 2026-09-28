"use strict";

/* ================================================================== */
/*  STRUCTURED OUTLINE                                                 */
/*  Chapter lines are the book's real chapters. Section notes become   */
/*  grayed "ghost" paragraphs in the manuscript                       */
/* ================================================================== */

const secLetter = (i) => String.fromCharCode(65 + (i % 26));

// Fold legacy chapter summaries into the two-level outline once, without losing text.
function migrateOutlineSummaries() {
  book.sectionNotes ||= {};
  const changed = [];
  for (const id of book.chapterOrder) {
    const summary = book.chapterNotes?.[id];
    if (summary) {
      (book.sectionNotes[id] ||= []).unshift({id:'sec-'+crypto.randomUUID(), text:summary});
      delete book.chapterNotes[id]; changed.push(id);
    }
  }
  if (changed.length) scheduleMetaSave();
  return changed;
}

function renderOutline(focusTarget) {
  book.sectionNotes = book.sectionNotes || {};
  book.chapterNotes = book.chapterNotes || {};
  migrateOutlineSummaries().forEach(syncGhosts);
  const wrap = $("#outline-list");
  wrap.innerHTML = "";
  if (NeoPlugins.render("outlineView", wrap)) return;
  NeoPlugins.notify("outline", wrap);

  book.chapterOrder.forEach((chId, i) => {
    wrap.appendChild(
      outlineLine(
        "chapter",
        chId,
        null,
        i,
        String(i + 1),
        book.chapterTitles?.[chId] || "",
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
    "Add a line with Enter. Indent with Tab; outdent with Shift+Tab. Remove an empty line with Backspace.";
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
  txt.className = kind === "chapter" ? "ol-text ol-title" : "ol-text";
  txt.contentEditable = "true";
  txt.spellcheck = false;
  txt.textContent = text;

  const save = () => {
    const val = txt.textContent.trim();
    if (kind === "chapter") {
      book.chapterTitles ||= {}; book.chapterTitles[chId] = val;
      const heading = document.querySelector(`.chapter[data-id="${chId}"] .ch-title`);
      if (heading) heading.textContent = val;
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

  // Enter at the very start of a line that has text makes the new line
  // ABOVE it (the only way to put something before "A"); anywhere else,
  // below — the way a text editor's outline behaves
  const caretAtStart = () => {
    if (!txt.textContent.trim()) return false;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const r = sel.getRangeAt(0);
    if (!txt.contains(r.startContainer)) return false;
    const head = document.createRange();
    head.selectNodeContents(txt);
    head.setEnd(r.startContainer, r.startOffset);
    return head.toString().length === 0;
  };

  txt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const above = caretAtStart();
      save();
      if (kind === 'chapter') {
        const at = book.chapterOrder.indexOf(chId) + (above ? 0 : 1);
        const newId = createChapterAt(at);
        renderOutline({ chId: newId });
      } else {
        const list = book.sectionNotes[chId];
        const newSec = { id: 'sec-' + Date.now().toString(36), text: '' };
        list.splice(index + (above ? 0 : 1), 0, newSec);
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
          "Indent only chapters without written prose.",
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
      book.sectionNotes[prevCh].push(newSec, ...(book.sectionNotes[chId] || []));
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
      book.chapterTitles ||= {}; book.chapterTitles[newId] = sec.text;
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
              ? "Keep its prose in Darlings."
              : "Remove this empty chapter.",
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
          desc: "Remove the outline prompt; keep written prose.",
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
$('#aux-editor').addEventListener('keydown', (e) => { if (styleKeepScroll(e)) return; smartKeys(e, e.currentTarget); });
$('#aux-editor').addEventListener('input', () => {
  auxDirty = true;
  scheduleAuxSave();
  {
    const key = "aux-" + ($("#aux-editor").dataset.kind || "notes");
    NeoPlugins.notify("changed", key, $("#aux-editor"));
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

// Shared structural operations for the outline and its optional card view.
// Chapter IDs and section IDs remain stable, including sections already written over.
async function moveOutlineChapter(chId, index) {
  if (!book.chapterOrder.includes(chId)) return;
  const order = book.chapterOrder.filter(id => id !== chId);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, chId);
  if (order.every((id, i) => id === book.chapterOrder[i])) return;
  snapshotStructure('chapter reorder');
  book.chapterOrder = order;
  await saveMeta(); renderChapters();
  if (currentTab === 'outline') renderOutline();
}

function createOutlineAccess(bookId, track) {
  const active = () => book && book.id === bookId;
  const valid = id => active() && book.chapterOrder.includes(id);
  return {
    snapshot() {
      if (!active()) return [];
      return book.chapterOrder.map(id => ({ id, title: book.chapterTitles?.[id] || '', sections: structuredClone(book.sectionNotes?.[id] || []) }));
    },
    update(id, field, value, sectionId) {
      if (!valid(id)) return;
      if (field === 'title') {
        book.chapterTitles ||= {}; book.chapterTitles[id] = value;
        const heading = document.querySelector(`.chapter[data-id="${id}"] .ch-title`);
        if (heading) heading.textContent = value;

      } else if (field === 'section') {
        const section = book.sectionNotes?.[id]?.find(s => s.id === sectionId);
        if (!section) return;
        section.text = value; syncGhosts(id);
      }
      scheduleMetaSave(); scheduleNavRefresh();
    },
    add: () => track(async () => {
      if (!active()) return null;
      snapshotStructure('outline chapter added');
      const id = createChapterAt(book.chapterOrder.length);
      await saveMeta(); return id;
    }),
    remove: id => track(async () => {
      if (!valid(id)) return;
      await chapterMenu(id, book.chapterOrder.indexOf(id));
    }),
    move: (id, index) => track(async () => { if (valid(id)) await moveOutlineChapter(id, index); }),
    addSection(id, afterId) {
      if (!valid(id)) return;
      snapshotStructure('outline section added');
      book.sectionNotes ||= {}; book.sectionNotes[id] ||= [];
      const section = { id: 'sec-' + crypto.randomUUID(), text: '' };
      const list = book.sectionNotes[id];
      const after = afterId ? list.findIndex(s => s.id === afterId) : -1;
      list.splice(after < 0 ? list.length : after + 1, 0, section);
      scheduleMetaSave(); return section.id;
    },
    removeSection(id, sectionId) {
      if (!valid(id)) return;
      snapshotStructure('outline section removed');
      book.sectionNotes[id] = (book.sectionNotes[id] || []).filter(s => s.id !== sectionId);
      syncGhosts(id); scheduleMetaSave();
    },
    get legacyImported() { return active() && !!book.legacyCardsImported; },
    importLegacy: cards => track(async () => {
      if (!active() || book.legacyCardsImported) return;
      snapshotStructure('legacy cards imported');
      for (const card of cards) {
        const id = createChapterAt(book.chapterOrder.length);
        book.chapterTitles ||= {}; book.chapterTitles[id] = String(card.title || '');
        book.sectionNotes ||= {};
        book.sectionNotes[id] = String(card.body || '').split(/\r?\n/).filter(Boolean).map(text => ({id:'sec-'+crypto.randomUUID(),text}));
        syncGhosts(id);
      }
      book.legacyCardsImported = true;
      await saveMeta(); renderChapters();
    })
  };
}
