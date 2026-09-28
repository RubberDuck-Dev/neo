"use strict";

// A small shell shared by settings screens; each screen owns its form and saving.
function settingsDialog({ title, scope, content, actions = '', className = '', onClose, canClose = () => true, back, tabs = [], host }) {
  const previous = host?._previousFocus || document.activeElement;
  const bd = host || document.createElement('div');
  bd._previousFocus = previous;
  bd.className = 'modal-backdrop';
  bd.innerHTML = `<div class="modal settings-dialog ${className}" role="dialog" tabindex="-1" aria-modal="true" aria-label="${escHtml(title)}">
    <header class="dialog-head"><div>${back ? '<button class="dialog-back btn-quiet">← Plugin Library</button>' : ''}<h2>${escHtml(title)}</h2><p class="dialog-scope">${escHtml(scope)}</p></div><button class="dialog-close btn-quiet" aria-label="Close">×</button></header>
    ${tabs.length ? `<nav class="settings-tabs" role="tablist" aria-label="Saving and recovery">${tabs.map((tab, index) => `<button role="tab" data-settings-tab="${index}" aria-selected="${!!tab.active}" tabindex="${tab.active ? 0 : -1}">${escHtml(tab.label)}</button>`).join("")}</nav>` : ""}
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
  bd.querySelectorAll('[data-settings-tab]').forEach(button => {
    const tab = tabs[Number(button.dataset.settingsTab)];
    button.onclick = () => { if (!tab.active && canClose()) tab.select(); };
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = Number(button.dataset.settingsTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = bd.querySelector(`[data-settings-tab="${next}"]`); target.focus(); target.click();
    };
  });
  bd.querySelector('.dialog-back')?.addEventListener('click', () => { if (close()) back(); });
  bd.onkeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const items = [...bd.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (!items.length) { event.preventDefault(); return; }
    if (document.activeElement === bd.firstElementChild) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  if (!bd.isConnected) document.body.appendChild(bd);
  (bd.querySelector('[role="tab"][aria-selected="true"]') || bd.querySelector('.dialog-close')).focus();
  const switchTo = show => {
    if (!canClose()) return;
    onClose?.();
    show(bd);
  };
  return { bd, close, switchTo };
}

// Dismiss only a click that starts and ends on the backdrop. Reuse each
// dialog's cancel/close handler so cleanup, pending promises and busy guards run.
let popupPointerDown = null;
document.addEventListener('pointerdown', event => { popupPointerDown = event.target; }, true);
document.addEventListener('click', event => {
  const bd = event.target;
  if (!(bd instanceof Element) || !bd.matches('.modal-backdrop') || popupPointerDown !== bd) return;
  const visible = [...document.querySelectorAll('.modal-backdrop')].filter(el => el.getClientRects().length);
  if (visible.at(-1) !== bd) return;
  const cancel = bd.querySelector('.dialog-close, .m-cancel');
  if (cancel) cancel.click();
  else bd.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
});
