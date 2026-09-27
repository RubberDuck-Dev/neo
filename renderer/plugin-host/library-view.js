"use strict";

function openPlugins() {
  const { bd, close } = settingsDialog({
    title: NeoI18n.t("plugins.title"), scope: 'Choose tools for ' + displayAuthor() + '. Library tools apply to every author.', className: 'plugin-modal',
    content: '<div class="plugin-grid"></div>', actions: '<span class="plugin-foot">Disabling a tool keeps its saved data.</span>'
  });
  const grid = bd.querySelector(".plugin-grid");
  function render() {
    grid.replaceChildren();
    for (const p of NeoPlugins.list()) {
      const card = document.createElement("section");
      card.className = `plugin-card ${p.enabled ? "installed" : ""}`;
      card.innerHTML = `<div class="plugin-icon">${escHtml(p.icon || "✦")}</div><div class="plugin-copy"><div class="plugin-kicker">${escHtml(p.kind)} · ${p.scope === "library" ? "Entire library" : "This author"}</div><h3>${escHtml(p.name)}</h3><span class="plugin-state">${p.enabled ? "Enabled" : "Not enabled"}</span><p>${escHtml(p.description)}</p></div><div class="plugin-actions"></div>`;
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
          render();
        } catch (err) { toast(`Could not change ${p.name}: ${err.message}`); toggle.disabled = false; }
      };
      actions.appendChild(toggle);
      if (p.enabled && p.configureLabel) {
        const configure = document.createElement("button");
        configure.className = "btn-gold";
        configure.textContent = p.configureLabel;
        configure.onclick = () => { close(); NeoPlugins.call(p.id, "configure"); };
        actions.appendChild(configure);
      }
      grid.appendChild(card);
    }
  }
  render();
}
$("#plugins-btn").onclick = openPlugins;
