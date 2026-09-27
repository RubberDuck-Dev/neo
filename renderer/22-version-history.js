"use strict";

/* ================================================================== */
/*  VERSION HISTORY — browse, compare, restore                        */
/* ================================================================== */

/* ---------- Compare a saved version with the manuscript as it is now ---------- */

// Paragraph texts of a chapter's saved HTML (outline ghosts and placeholder
// marks are scaffolding, not prose).
function comparableParas(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  holder.querySelectorAll(".ghost, .ph-mark").forEach((n) => n.remove());
  return [...holder.querySelectorAll("p")]
    .map((p) => (p.classList.contains("scene-break") ? "***" : p.textContent.replace(/ /g, " ").trim()))
    .filter(Boolean);
}

// Longest-common-subsequence diff of two token lists → [{op: "=", "+", "-", items}]
function diffLists(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [{ op: "-", items: a }, { op: "+", items: b }]; // too big to align; show as rewritten
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, item) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.items.push(item);
    else out.push({ op, items: [item] });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("=", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push("-", a[i++]);
    else push("+", b[j++]);
  }
  while (i < n) push("-", a[i++]);
  while (j < m) push("+", b[j++]);
  return out;
}

const countParaWords = (texts) => texts.reduce((sum, t) => sum + (t.match(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu) || []).length, 0);

// Mostly the same paragraph? Otherwise a word diff is just noise.
function similarParas(a, b) {
  const wa = a.toLowerCase().match(/[\p{L}\p{N}’']+/gu) || [];
  const wb = b.toLowerCase().match(/[\p{L}\p{N}’']+/gu) || [];
  if (!wa.length || !wb.length) return false;
  const same = diffLists(wa, wb).filter((p) => p.op === "=").reduce((n, p) => n + p.items.length, 0);
  return same / Math.max(wa.length, wb.length) >= 0.4;
}

// One paragraph rewritten: show the words that changed inside it.
function wordDiffHtml(before, after) {
  const words = (t) => t.match(/\s+|[\p{L}\p{N}’']+|[^\s\p{L}\p{N}]/gu) || [];
  let added = 0, removed = 0;
  const html = diffLists(words(before), words(after)).map((part) => {
    const text = escHtml(part.items.join(""));
    if (part.op === "=") return text;
    const n = countParaWords([part.items.join("")]);
    if (part.op === "+") { added += n; return `<ins>${text}</ins>`; }
    removed += n;
    return `<del>${text}</del>`;
  }).join("");
  return { html, added, removed };
}

// A chapter's changes as HTML, with one paragraph of context either side.
function chapterDiffHtml(oldParas, newParas) {
  const parts = diffLists(oldParas, newParas);
  const blocks = [];
  let added = 0, removed = 0;
  parts.forEach((part, k) => {
    if (part.op === "=") {
      const prevChanged = k > 0, nextChanged = k < parts.length - 1;
      const items = part.items;
      if (items.length <= 2) {
        if (prevChanged || nextChanged) items.forEach((t) => blocks.push(`<p class="cmp-same">${escHtml(t)}</p>`));
      } else {
        if (prevChanged) blocks.push(`<p class="cmp-same">${escHtml(items[0])}</p>`);
        if (prevChanged && nextChanged) blocks.push('<p class="cmp-gap">⋯</p>');
        if (nextChanged) blocks.push(`<p class="cmp-same">${escHtml(items[items.length - 1])}</p>`);
      }
      return;
    }
    if (part.op === "-" && parts[k + 1] && parts[k + 1].op === "+") {
      // paired rewrite: diff paragraph by paragraph, words inside
      const next = parts[k + 1];
      const pairs = Math.min(part.items.length, next.items.length);
      for (let x = 0; x < pairs; x++) {
        if (similarParas(part.items[x], next.items[x])) {
          const w = wordDiffHtml(part.items[x], next.items[x]);
          blocks.push(`<p class="cmp-edit">${w.html}</p>`);
          added += w.added;
          removed += w.removed;
        } else {
          blocks.push(`<p class="cmp-del">${escHtml(part.items[x])}</p>`, `<p class="cmp-ins">${escHtml(next.items[x])}</p>`);
          removed += countParaWords([part.items[x]]);
          added += countParaWords([next.items[x]]);
        }
      }
      part.items.slice(pairs).forEach((t) => blocks.push(`<p class="cmp-del">${escHtml(t)}</p>`));
      next.items.slice(pairs).forEach((t) => blocks.push(`<p class="cmp-ins">${escHtml(t)}</p>`));
      removed += countParaWords(part.items.slice(pairs));
      added += countParaWords(next.items.slice(pairs));
      next.handled = true;
      return;
    }
    if (part.handled) return;
    if (part.op === "-") { part.items.forEach((t) => blocks.push(`<p class="cmp-del">${escHtml(t)}</p>`)); removed += countParaWords(part.items); }
    else { part.items.forEach((t) => blocks.push(`<p class="cmp-ins">${escHtml(t)}</p>`)); added += countParaWords(part.items); }
  });
  return { html: blocks.join(""), added, removed, changed: parts.some((p) => p.op !== "=") };
}

async function openVersionCompare(bookId, checkpointId) {
  if (!book || book.id !== bookId) return;
  flushAllSaves();
  let saved;
  try {
    saved = await window.neo.readCheckpoint(bookId, checkpointId);
  } catch (err) {
    toast(ipcErrorText(err, "NEO couldn’t read that version.").text, 6000);
    return;
  }
  const label = (meta, chId, i) => {
    const title = (meta.chapterTitles || {})[chId];
    return `Chapter ${i + 1}${title ? ": " + escHtml(title) : ""}`;
  };
  const nowOrder = book.chapterOrder;
  const thenOrder = saved.meta.chapterOrder || Object.keys(saved.chapters);
  // "moved" means its place among the chapters both versions share changed,
  // not just that an earlier chapter was added or cut
  const nowShared = nowOrder.filter((id) => thenOrder.includes(id));
  const thenShared = thenOrder.filter((id) => nowOrder.includes(id));
  const sections = [];
  let totalAdded = 0, totalRemoved = 0;
  nowOrder.forEach((chId, i) => {
    const before = thenOrder.includes(chId) ? comparableParas(saved.chapters[chId]) : [];
    const after = comparableParas(chapterHTML[chId]);
    const d = chapterDiffHtml(before, after);
    const moved = thenOrder.includes(chId) && nowShared.indexOf(chId) !== thenShared.indexOf(chId);
    if (!d.changed && !moved && thenOrder.includes(chId)) return;
    totalAdded += d.added; totalRemoved += d.removed;
    const tag = !thenOrder.includes(chId) ? "new since then" : moved ? `was chapter ${thenOrder.indexOf(chId) + 1}` : "";
    sections.push({ title: label(book, chId, i), tag, added: d.added, removed: d.removed, html: d.html });
  });
  thenOrder.forEach((chId, i) => {
    if (nowOrder.includes(chId)) return;
    const before = comparableParas(saved.chapters[chId]);
    totalRemoved += countParaWords(before);
    sections.push({ title: label(saved.meta, chId, i), tag: "deleted since then", added: 0, removed: countParaWords(before), html: before.map((t) => `<p class="cmp-del">${escHtml(t)}</p>`).join("") });
  });

  const when = new Date(saved.createdAt).toLocaleString();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal compare-modal">
      <div class="stats-modal-head"><h2 style="font-size:17px">Changes since ${escHtml(when)}</h2><button class="m-cancel btn-quiet" title="Close">×</button></div>
      <p class="soft">${sections.length ? `${sections.length} chapter${sections.length === 1 ? "" : "s"} changed · <span class="cmp-plus">+${totalAdded}</span> / <span class="cmp-minus">−${totalRemoved}</span> words. <ins>Added</ins> and <del>removed</del> text is marked.` : "The manuscript is the same as this version."}</p>
      <div class="compare-list">${sections.map((s, k) => `
        <details class="compare-ch"${k === 0 ? " open" : ""}>
          <summary><span>${s.title}${s.tag ? ` <small>· ${escHtml(s.tag)}</small>` : ""}</span><span class="cmp-count"><span class="cmp-plus">+${s.added}</span> <span class="cmp-minus">−${s.removed}</span></span></summary>
          <div class="compare-body">${s.html || '<p class="cmp-gap">Only moved.</p>'}</div>
        </details>`).join("")}</div>
      <div style="text-align:right;margin-top:14px"><button class="m-ok btn-gold">Done</button></div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelectorAll(".m-ok, .m-cancel").forEach((b) => (b.onclick = close));
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
  bd.querySelector(".m-ok").focus();
}

async function openVersionHistory(bookId) {
  const versions = await window.neo.listCheckpoints(bookId);
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const rows = versions.length
    ? versions.map((version) => {
      const when = version.createdAt ? new Date(version.createdAt).toLocaleString() : "Unknown date";
      const note = version.valid ? (version.reason || "writing") : `unavailable — ${escHtml(version.error || "failed verification")}`;
      return `<div class="history-row"><span><strong>${when}</strong><br><small>${escHtml(note)}</small></span><span class="history-actions"><button data-compare="${escHtml(version.id)}" class="btn-quiet"${version.valid ? "" : " disabled"}>Compare</button><button data-version="${escHtml(version.id)}"${version.valid ? "" : " disabled"}>Restore</button></span></div>`;
    }).join("")
    : '<p class="soft">No version checkpoints yet.</p>';
  bd.innerHTML = `
    <div class="modal" style="width:540px">
      <h2 style="font-size:17px">Version history</h2>
      <p>Compare shows what changed since a version. Restoring first saves your current manuscript as a new version.</p>
      <div class="history-list">${rows}</div>
      <div style="text-align:right;margin-top:14px"><button class="m-ok btn-gold">Done</button></div>
    </div>`;
  document.body.appendChild(bd);
  bd.querySelector(".m-ok").onclick = () => bd.remove();
  bd.querySelectorAll("[data-compare]").forEach((button) => {
    button.onclick = () => openVersionCompare(bookId, button.dataset.compare);
  });
  bd.querySelectorAll("[data-version]").forEach((button) => {
    button.onclick = async () => {
      const choice = await optionModal("Restore this version?", "Your current manuscript will be preserved as a new version first.", [
        { label: "Restore version", desc: "Replace the current book with this saved version.", value: "restore", danger: true },
      ]);
      if (choice !== "restore") return;
      button.disabled = true;
      try {
        await window.neo.restoreCheckpoint(bookId, button.dataset.version);
        bd.remove();
        await openBook(bookId);
        toast("Version restored — the version you were editing was saved first.", 5000);
      } catch (err) {
        button.disabled = false;
        toast("NEO couldn't restore that version. Your current manuscript is still safe.", 6000);
        window.neo.logError(`restore checkpoint: ${err && err.stack ? err.stack : err}`);
      }
    };
  });
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      bd.remove();
    }
  });
}
