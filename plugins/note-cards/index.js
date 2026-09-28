"use strict";
NeoPlugins.define('noteCards', { name:'Outline cards', icon:'▤', kind:'Planning', description:'Plan with index cards or an indented outline. Both edit the same book structure.', bookScoped:true, bookFields:['outlineCardView'] }, async ctx => {
  if (!ctx.hasBook) return {};
  const legacy = await ctx.readData('note-cards', []), model = ctx.outline;
  let cardView = !!ctx.bookSnapshot().outlineCardView, draggingId = null, preview = null;
  const refresh = () => ctx.refreshOutline();
  const run = async work => { try { await work(); } catch (err) { ctx.toast(`Could not update outline: ${err.message}`); } };
  const clearDrag = () => {
    draggingId = null; preview?.remove(); preview = null;
    document.querySelectorAll('.cards-grid.is-dragging,.note-card.dragging,.note-card.drop-before,.note-card.drop-after').forEach(n => n.classList.remove('is-dragging','dragging','drop-before','drop-after'));
  };
  const setView = value => { document.activeElement?.blur(); clearDrag(); cardView = value; ctx.updateBook({outlineCardView:value}); refresh(); };
  ctx.listen(document,'keydown',event => {
    if (ctx.currentTab !== 'outline' || !(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.code !== 'KeyC' || document.querySelector('.modal-backdrop:not([hidden])')) return;
    event.preventDefault(); event.stopPropagation(); setView(!cardView);
  },{capture:true});
  const toolbar = ctx.mountOutlineControls(document.createElement('div'));
  toolbar.className = 'outline-view-toolbar';
  toolbar.innerHTML = `<div role="group" aria-label="Outline view" title="Switch view: Ctrl/⌘+Alt+C"><button data-outline-view="list">Outline</button><button data-outline-view="cards">Cards</button></div><button class="add-card">+ Card</button>`;
  toolbar.querySelector('[data-outline-view="list"]').onclick = () => setView(false);
  toolbar.querySelector('[data-outline-view="cards"]').onclick = () => setView(true);
  toolbar.querySelector('.add-card').onclick = () => run(async () => {
    const id = await model.add(); refresh();
    document.querySelector(`[data-card-id="${id}"] .note-card-title`)?.focus();
  });
  function render(wrap) {
    toolbar.querySelector('[data-outline-view="list"]').setAttribute('aria-pressed', !cardView);
    toolbar.querySelector('[data-outline-view="cards"]').setAttribute('aria-pressed', cardView);
    toolbar.querySelector('.add-card').hidden = !cardView;
    if (Array.isArray(legacy) && legacy.length && !model.legacyImported) {
      const notice = document.createElement('div'); notice.className = 'cards-legacy';
      notice.textContent = `${legacy.length} saved standalone cards can be imported. Keep the originals. `;
      const button = document.createElement('button'); button.textContent = 'Import saved cards';
      button.onclick = () => run(async () => { button.disabled = true; try { await model.importLegacy(legacy); refresh(); } finally { button.disabled = false; } });
      notice.appendChild(button); wrap.appendChild(notice);
    }
    if (!cardView) return false;
    const grid = document.createElement('div'); grid.className = 'cards-grid'; wrap.appendChild(grid);
    const cards = model.snapshot();
    cards.forEach((card,index) => {
      const el = document.createElement('article'); el.className = 'note-card'; el.dataset.cardId = card.id;
      el.innerHTML = `<div class="card-tools"><button class="card-drag" draggable="true" title="Drag to move card" aria-label="Move card ${index+1}; use Alt and arrow keys to reorder">⠿</button></div><div class="note-card-title" contenteditable="plaintext-only" role="textbox" aria-label="Title (optional)" data-placeholder="Title (optional)"></div><div class="note-card-body"></div>`;
      const title = el.querySelector('.note-card-title'), body = el.querySelector('.note-card-body');
      title.textContent = card.title;
      title.oninput = () => model.update(card.id,'title',title.innerText);
      const focusSection = id => wrap.querySelector(`[data-section-id="${id}"]`)?.focus();
      (card.sections.length ? card.sections : [{text:''}]).forEach(section => {
        const text = document.createElement('div'); text.className = 'card-section'; text.contentEditable = 'plaintext-only';
        text.setAttribute('role','textbox'); text.setAttribute('aria-label','Subsection'); text.dataset.placeholder = 'Subsection…';
        if (section.id) text.dataset.sectionId = section.id;
        text.textContent = section.text;
        text.oninput = () => {
          if (!section.id) { section.id = model.addSection(card.id); text.dataset.sectionId = section.id; }
          model.update(card.id,'section',text.innerText,section.id);
        };
        text.onkeydown = event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); const id = model.addSection(card.id,section.id); refresh(); focusSection(id);
          } else if (event.key === 'Backspace' && !text.textContent && section.id) {
            event.preventDefault(); const previous = text.previousElementSibling?.dataset.sectionId;
            model.removeSection(card.id,section.id); refresh();
            if (previous) focusSection(previous); else wrap.querySelector(`[data-card-id="${card.id}"] .note-card-title`)?.focus();
          }
        };
        body.appendChild(text);
      });
      title.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); body.firstElementChild.focus(); } };
      el.oncontextmenu = event => {
        event.preventDefault(); event.stopPropagation();
        run(async () => { await model.remove(card.id); refresh(); });
      };
      const grip = el.querySelector('.card-drag');
      grip.onkeydown = event => {
        if (!event.altKey || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        run(async () => { await model.move(card.id,index + (['ArrowUp','ArrowLeft'].includes(event.key) ? -1 : 1)); wrap.querySelector(`[data-card-id="${card.id}"] .card-drag`)?.focus(); });
      };
      grip.ondragstart = event => {
        draggingId = card.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-neo-outline-card',card.id);
        preview = el.cloneNode(true); preview.classList.add('card-drag-preview'); preview.style.width = `${el.offsetWidth}px`; document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview,24,20); el.classList.add('dragging'); grid.classList.add('is-dragging');
      };
      grip.ondragend = clearDrag;
      el.ondragover = event => {
        if (!draggingId || draggingId === card.id) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        grid.querySelectorAll('.drop-before,.drop-after').forEach(n => n.classList.remove('drop-before','drop-after'));
        const rect = el.getBoundingClientRect(), columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        grid.classList.toggle('single-column',columns === 1);
        const after = columns > 1 ? event.clientX > rect.left + rect.width/2 : event.clientY > rect.top + rect.height/2;
        el.classList.add(after ? 'drop-after' : 'drop-before');
      };
      el.ondragleave = event => { if (!el.contains(event.relatedTarget)) el.classList.remove('drop-before','drop-after'); };
      el.ondrop = event => {
        if (!draggingId || draggingId === card.id) return;
        event.preventDefault(); const order = cards.filter(c => c.id !== draggingId);
        const to = order.findIndex(c => c.id === card.id) + (el.classList.contains('drop-after') ? 1 : 0);
        const id = draggingId; clearDrag(); run(() => model.move(id,to));
      };
      grid.appendChild(el);
    });
    return true;
  }
  return {outlineView:render,dispose:clearDrag};
});
