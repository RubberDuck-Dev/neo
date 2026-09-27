"use strict";
NeoPlugins.define("noteCards", { name: "Note cards", icon: "▤", kind: "Writing tool", description: "Keep research, character, and scene cards with each book.", bookScoped: true }, async (ctx) => {
if (!ctx.hasBook) return {};
let noteCards = await ctx.readData("note-cards", []);
const panel = ctx.addTab("cards", "Cards");
function saveNoteCards() {
  ctx.writeData("note-cards", noteCards);
}
function renderNoteCards() {
  const wrap = panel;
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

return { tab(name) {
  if (name !== "cards") return false;
  ctx.$("#aux-title").textContent = "Note cards";
  panel.hidden = false;
  renderNoteCards();
  return true;
} };
});
