"use strict";

function openPlugins() {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `<div class="modal plugin-modal"><div class="plugin-modal-head"><div><h2>${escHtml(NeoI18n.t("plugins.title"))}</h2><p>Choose tools for ${escHtml(displayAuthor())}. Library tools apply to every author.</p></div><button class="m-cancel btn-quiet" title="Close">×</button></div><div class="plugin-grid"></div><p class="plugin-foot">Disabling a tool keeps its saved data.</p></div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector(".m-cancel").onclick = close;
  const grid = bd.querySelector(".plugin-grid");
  function render() {
    grid.replaceChildren();
    for (const p of NeoPlugins.list()) {
      const card = document.createElement("section");
      card.className = `plugin-card ${p.enabled ? "installed" : ""}`;
      card.innerHTML = `<div class="plugin-icon">${escHtml(p.icon || "✦")}</div><div class="plugin-copy"><div class="plugin-kicker">${escHtml(p.kind)} · ${p.scope === "library" ? "Entire library" : "This author"}</div><h3>${escHtml(p.name)}</h3><p>${escHtml(p.description)}</p></div><div class="plugin-actions"></div>`;
      const actions = card.querySelector(".plugin-actions");
      const toggle = document.createElement("button");
      toggle.dataset.plugin = p.id;
      toggle.className = p.enabled ? "btn-quiet" : "btn-gold";
      toggle.textContent = !p.available ? "Unavailable on this device" : NeoI18n.t(p.enabled ? "plugins.disable" : "plugins.enable");
      toggle.disabled = !p.available;
      toggle.onclick = async () => {
        toggle.disabled = true;
        try {
          await NeoPlugins.setEnabled(p.id, !p.enabled);
          // Keep existing keyboard/menu workflow: enabling returns to writing.
          if (!p.enabled) close(); else render();
        } catch (err) { toast(`Could not change ${p.name}: ${err.message}`); toggle.disabled = false; }
      };
      actions.appendChild(toggle);
      if (p.enabled && p.configureLabel) {
        const configure = document.createElement("button");
        configure.className = "btn-quiet";
        configure.textContent = p.configureLabel;
        configure.onclick = () => { close(); NeoPlugins.call(p.id, "configure"); };
        actions.appendChild(configure);
      }
      grid.appendChild(card);
    }
  }
  render();
  bd.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
}
$("#plugins-btn").onclick = openPlugins;
