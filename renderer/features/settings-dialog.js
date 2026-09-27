"use strict";

// A small shell shared by settings screens; each screen owns its form and saving.
function settingsDialog({ title, scope, content, actions = '', className = '', onClose, canClose = () => true, back }) {
  const previous = document.activeElement;
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal settings-dialog ${className}" role="dialog" tabindex="-1" aria-modal="true" aria-label="${escHtml(title)}">
    <header class="dialog-head"><div>${back ? '<button class="dialog-back btn-quiet">← Plugin Library</button>' : ''}<h2>${escHtml(title)}</h2><p class="dialog-scope">${escHtml(scope)}</p></div><button class="dialog-close btn-quiet" aria-label="Close">×</button></header>
    <div class="dialog-body">${content}</div>
    <footer class="dialog-footer">${actions}</footer></div>`;
  const close = () => {
    if (!canClose()) return false;
    onClose?.();
    bd.remove();
    if (previous?.isConnected) previous.focus();
    return true;
  };
  bd.querySelector('.dialog-close').onclick = close;
  bd.querySelector('.dialog-back')?.addEventListener('click', () => { if (close()) back(); });
  bd.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const items = [...bd.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (!items.length) { event.preventDefault(); return; }
    if (document.activeElement === bd.firstElementChild) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.body.appendChild(bd);
  bd.querySelector('.dialog-close').focus();
  return { bd, close };
}
