"use strict";

/* ================================================================== */
/*  PLUGINS — per pen name: palettes, Story Map, Note cards, Sprints, GitHub*/
/* ================================================================== */

// Plugins belong to an author, rather than to a computer or an individual
// book. A writer can keep a spare pen name deliberately uncluttered, while
// every book under an enabled pen name gets the same tools.
const PLUGINS = {
  palette: { name: "Palette themes", icon: "◐", kind: "Personalization", description: "Give this author a distinct writing-room palette.", status: "Ready" },
  storyMap: { name: "Story Map", icon: "↗", kind: "Planning", description: "Map each chapter’s act, story beat, thread, and progress beside the working outline.", status: "Ready" },
  sprints: { name: "Writing Sprints", icon: "⚡", kind: "Writing tool", description: "Race a timer or a word count, NaNoWriMo-style. Start one from Progress & Settings; the word counter becomes the countdown.", status: "Ready" },
  noteCards: { name: "Note cards", icon: "▤", kind: "Writing tool", description: "Keep research, character, and scene cards with each book.", status: "Ready" },
  github: { name: "GitHub backup", icon: "⌘", kind: "Backup", description: "Keep an automatic, private backup of your entire NEO Library on GitHub.", status: "Ready" }
};
const PALETTE_PRESETS = {
  classic: { name: "Classic gold", bg: "#191919", bgSoft: "#222222", pane: "#202020", paper: "#fbfaf7", ink: "#1c1c1c", accent: "#c9a86a", muted: "#8a8a8a", paperMuted: "#665f54", paperFaint: "#b9b4a8", uiText: "#dddddd", uiTextSoft: "#aaaaaa", line: "#3a3a3a", lineStrong: "#4a4a4a", surface: "#222222", surfaceRaised: "#2a2a26", danger: "#c0392b", dangerMuted: "#9d4d42", resolved: "#625d52", onAccent: "#191919", nightPaper: "#232221", nightInk: "#d6d2c6", nightMuted: "#918b7d", nightFaint: "#5f5b52" },
  ink: { name: "Ink blue", bg: "#151d29", bgSoft: "#1d2838", pane: "#172230", paper: "#eef4fa", ink: "#17263a", accent: "#4e8bc5", muted: "#9aafc5", paperMuted: "#52677d", paperFaint: "#aab9c8", uiText: "#e7eff8", uiTextSoft: "#b8c7d7", line: "#34485f", lineStrong: "#47627f", surface: "#1d2838", surfaceRaised: "#26364a", danger: "#d66d6b", dangerMuted: "#a95a62", resolved: "#667789", onAccent: "#ffffff", nightPaper: "#172331", nightInk: "#d9e7f4", nightMuted: "#91acc6", nightFaint: "#59718a" },
  moss: { name: "Moss green", bg: "#19201b", bgSoft: "#222b23", pane: "#1c261e", paper: "#f4f5ed", ink: "#263127", accent: "#819b4e", muted: "#a2ad94", paperMuted: "#5d6b57", paperFaint: "#b4baaa", uiText: "#e8eee3", uiTextSoft: "#bdc7b5", line: "#3c4b3d", lineStrong: "#536653", surface: "#222b23", surfaceRaised: "#2b372d", danger: "#c46c5f", dangerMuted: "#99544c", resolved: "#697463", onAccent: "#172013", nightPaper: "#202a21", nightInk: "#e0e7d8", nightMuted: "#a6b69b", nightFaint: "#64735f" }
};
const PALETTE_KEYS = ["bg", "bgSoft", "pane", "paper", "ink", "accent", "muted", "paperMuted", "paperFaint", "uiText", "uiTextSoft", "line", "lineStrong", "surface", "surfaceRaised", "danger", "dangerMuted", "resolved", "onAccent", "nightPaper", "nightInk", "nightMuted", "nightFaint"];
const PALETTE_CSS_VARS = { bg: "--bg", bgSoft: "--bg-soft", pane: "--pane", paper: "--paper", ink: "--ink", accent: "--accent", muted: "--muted", paperMuted: "--paper-muted", paperFaint: "--paper-faint", uiText: "--ui-text", uiTextSoft: "--ui-text-soft", line: "--line", lineStrong: "--line-strong", surface: "--surface", surfaceRaised: "--surface-raised", danger: "--danger", dangerMuted: "--danger-muted", resolved: "--resolved", onAccent: "--on-accent", nightPaper: "--night-paper", nightInk: "--night-ink", nightMuted: "--night-muted", nightFaint: "--night-faint" };
function paletteFor(author) {
  const selected = author.pluginPalette || "classic";
  return PALETTE_PRESETS[selected] || (author.customPalettes || []).find((p) => p.id === selected) || PALETTE_PRESETS.classic;
}
function paletteMatches(a, b) {
  return PALETTE_KEYS.every((key) => (a[key] || PALETTE_PRESETS.classic[key]) === (b[key] || PALETTE_PRESETS.classic[key]));
}
function paletteWidget(author) {
  return `<div class="palette-widget"><button data-open-palette-studio class="palette-studio-link">Open Palette Studio →</button></div>`;
}
function paletteStudioGroup(title, description, keys, colors) {
  const labels = { bg: "Window background", bgSoft: "Dialog background", pane: "Side panes", surface: "Raised surfaces", surfaceRaised: "Active surfaces", uiText: "Primary interface text", uiTextSoft: "Secondary interface text", line: "Borders", lineStrong: "Strong borders", paper: "Page", ink: "Manuscript ink", paperMuted: "Page details", paperFaint: "Page placeholders", accent: "Primary action", onAccent: "Text on primary action", danger: "Flags & alerts", dangerMuted: "Alert hover", resolved: "Resolved notes", muted: "Quiet interface text", nightPaper: "Night page", nightInk: "Night manuscript ink", nightMuted: "Night page details", nightFaint: "Night placeholders" };
  return `<section class="palette-group"><div><h3>${title}</h3><p>${description}</p></div><div class="palette-color-grid">${keys.map((key) => `<label class="palette-swatch"><input type="color" data-palette-color="${key}" value="${colors[key] || PALETTE_PRESETS.classic[key]}"><span class="palette-swatch-dot" style="background:${colors[key] || PALETTE_PRESETS.classic[key]}"></span><span>${labels[key]}</span></label>`).join("")}</div></section>`;
}
function openPaletteStudio() {
  const author = currentAuthor();
  const colors = paletteFor(author);
  const selected = author.pluginPalette || "classic";
  const customOptions = (author.customPalettes || []).map((p) => `<option value="${p.id}" ${selected === p.id ? "selected" : ""}>${escHtml(p.name)}</option>`).join("");
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `<div class="modal palette-studio-screen"><div class="palette-studio-top"><button class="palette-back btn-quiet">← Plugin Library</button><button class="m-cancel btn-quiet" title="Close">×</button></div><div class="palette-studio-title"><h2>Palette Studio</h2><p>Every swatch has a job. Edit the writing room live, then save this combination as a custom palette.</p></div><div class="palette-studio-controls"><label><span>Active palette</span><select data-studio-palette><option value="classic" ${selected === "classic" ? "selected" : ""}>Classic gold</option><option value="ink" ${selected === "ink" ? "selected" : ""}>Ink blue</option><option value="moss" ${selected === "moss" ? "selected" : ""}>Moss green</option>${customOptions}</select></label><div class="palette-studio-actions"><button data-studio-reset class="palette-reset">Restore default palette</button><button data-delete-palette class="palette-delete" hidden>Delete custom palette</button></div></div><div class="palette-preview"><div class="palette-preview-chrome"><span>NEO</span><span class="preview-flag">● Flag</span></div><div class="palette-preview-pane">Chapters<br><strong>Chapter one</strong></div><div class="palette-preview-page"><small>CHAPTER ONE</small><h3>A page that feels like yours</h3><p>Manuscript ink, quiet details, and placeholders all respond to their own palette roles.</p><em>Write freely…</em><button>Primary action</button></div></div>${paletteStudioGroup("Writing page", "These colors control the paper itself in the normal page view.", ["paper", "ink", "paperMuted", "paperFaint"], colors)}${paletteStudioGroup("Night page", "These replace the page colors when View → Page → Night is active.", ["nightPaper", "nightInk", "nightMuted", "nightFaint"], colors)}${paletteStudioGroup("Writing room", "These paint the window, panes, dialogs, borders, and interface text.", ["bg", "bgSoft", "pane", "surface", "surfaceRaised", "uiText", "uiTextSoft", "muted", "line", "lineStrong"], colors)}${paletteStudioGroup("Signals & actions", "Shared colors for buttons, selection, flags, alerts, and resolved notes.", ["accent", "onAccent", "danger", "dangerMuted", "resolved"], colors)}<div class="palette-studio-save"><input data-palette-name placeholder="Name this custom palette" maxlength="36"><button data-save-palette class="btn-gold">Save custom palette</button></div></div>`;
  document.body.appendChild(bd);
  const close = () => { applyPluginAppearance(); bd.remove(); };
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelector(".palette-back").onclick = () => { close(); openPlugins(); };
  const preview = bd.querySelector(".palette-preview");
  let draftPalette = false;
  const picker = bd.querySelector("[data-studio-palette]");
  const markDraftPalette = () => {
    if (draftPalette || !["classic", "ink", "moss"].includes(picker.value)) return;
    picker.insertAdjacentHTML("beforeend", `<option value="__draft__">Custom (unsaved)</option>`);
    picker.value = "__draft__";
    draftPalette = true;
  };
  const deleteButton = bd.querySelector("[data-delete-palette]");
  const syncDeleteButton = () => {
    deleteButton.hidden = !picker.value.startsWith("custom-");
  };
  const previewVars = () => {
    const get = (key) => bd.querySelector(`[data-palette-color="${key}"]`).value;
    preview.style.setProperty("--preview-bg", get("bg")); preview.style.setProperty("--preview-pane", get("pane")); preview.style.setProperty("--preview-paper", get("paper")); preview.style.setProperty("--preview-ink", get("ink")); preview.style.setProperty("--preview-muted", get("paperMuted")); preview.style.setProperty("--preview-faint", get("paperFaint")); preview.style.setProperty("--preview-accent", get("accent")); preview.style.setProperty("--preview-on-accent", get("onAccent")); preview.style.setProperty("--preview-danger", get("danger"));
  };
  bd.querySelectorAll("[data-palette-color]").forEach((input) => {
    input.oninput = () => {
      markDraftPalette();
      const key = input.dataset.paletteColor;
      document.body.style.setProperty(PALETTE_CSS_VARS[key], input.value);
      const nightTarget = { nightPaper: "--paper", nightInk: "--ink", nightMuted: "--paper-muted", nightFaint: "--paper-faint" }[key];
      if (nightTarget && library.pageTheme === "night") document.body.style.setProperty(nightTarget, input.value);
      input.nextElementSibling.style.background = input.value;
      previewVars();
    };
  });
  previewVars();
  const syncStudioColors = (next) => {
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = next[input.dataset.paletteColor] || PALETTE_PRESETS.classic[input.dataset.paletteColor];
      input.nextElementSibling.style.background = input.value;
    });
    previewVars();
  };
  picker.onchange = async (e) => {
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    author.pluginPalette = e.target.value;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    syncStudioColors(paletteFor(author));
    syncDeleteButton();
  };
  bd.querySelector("[data-studio-reset]").onclick = async () => {
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    picker.value = "classic";
    syncStudioColors(PALETTE_PRESETS.classic);
    syncDeleteButton();
    toast("Returned to NEO’s default colors");
  };
  deleteButton.onclick = async () => {
    const id = picker.value;
    const removed = (author.customPalettes || []).find((p) => p.id === id);
    if (!removed) return;
    author.customPalettes = author.customPalettes.filter((p) => p.id !== id);
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    picker.querySelector(`[value="${id}"]`)?.remove();
    picker.value = "classic";
    syncStudioColors(PALETTE_PRESETS.classic);
    syncDeleteButton();
    toast(`Deleted “${removed.name || "custom palette"}”`);
  };
  syncDeleteButton();
  bd.querySelector("[data-save-palette]").onclick = async () => {
    const name = bd.querySelector("[data-palette-name]").value.trim() || "Custom palette";
    const saved = {};
    bd.querySelectorAll("[data-palette-color]").forEach((input) => { saved[input.dataset.paletteColor] = input.value; });
    const id = "custom-" + Date.now().toString(36);
    const builtInMatch = Object.entries(PALETTE_PRESETS).find(([, preset]) => paletteMatches(saved, preset));
    const customMatch = (author.customPalettes || []).find((preset) => paletteMatches(saved, preset));
    const matchingId = builtInMatch ? builtInMatch[0] : customMatch?.id;
    if (matchingId) {
      author.pluginPalette = matchingId;
      await window.neo.writeLibrary(library);
      applyPluginAppearance();
      draftPalette = false;
      picker.querySelector('[value="__draft__"]')?.remove();
      picker.value = matchingId;
      syncStudioColors(paletteFor(author));
      syncDeleteButton();
      bd.querySelector("[data-palette-name]").value = "";
      toast("That palette already exists — kept the existing palette");
      return;
    }
    author.customPalettes = [...(author.customPalettes || []), { id, name, ...saved }];
    author.pluginPalette = id;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    draftPalette = false;
    picker.querySelector('[value="__draft__"]')?.remove();
    picker.insertAdjacentHTML("beforeend", `<option value="${id}" selected>${escHtml(name)}</option>`);
    picker.value = id;
    syncDeleteButton();
    bd.querySelector("[data-palette-name]").value = "";
    toast(`Saved “${name}” for ${displayAuthor()}`);
  };
  bd.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}
function authorPlugins() {
  const author = currentAuthor();
  author.plugins = Array.isArray(author.plugins) ? author.plugins : [];
  return author.plugins;
}
function pluginEnabled(id) { return authorPlugins().includes(id); }
function applyPluginAppearance() {
  const author = currentAuthor();
  const hasPalette = pluginEnabled("palette");
  const colors = hasPalette ? paletteFor(author) : PALETTE_PRESETS.classic;
  document.body.dataset.palette = hasPalette ? (author.pluginPalette || "classic") : "classic";
  PALETTE_KEYS.forEach((key) => {
    if (hasPalette) document.body.style.setProperty(PALETTE_CSS_VARS[key], colors[key] || PALETTE_PRESETS.classic[key]);
    else document.body.style.removeProperty(PALETTE_CSS_VARS[key]);
  });
  if (hasPalette && library.pageTheme === "night") {
    document.body.style.setProperty("--paper", colors.nightPaper || colors.pane);
    document.body.style.setProperty("--ink", colors.nightInk || colors.uiText);
    document.body.style.setProperty("--paper-muted", colors.nightMuted || colors.muted);
    document.body.style.setProperty("--paper-faint", colors.nightFaint || colors.lineStrong);
  }
  if (sprint && !pluginEnabled("sprints")) { endSprintQuietly(); if (book) updateCounters(); }
  const cardsTab = $('.tab[data-tab="cards"]');
  if (cardsTab) cardsTab.hidden = !pluginEnabled("noteCards");
  if (currentTab === "cards" && !pluginEnabled("noteCards")) switchTab("manuscript");
}
function openPlugins() {
  const author = currentAuthor();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `<div class="modal plugin-modal"><div class="plugin-modal-head"><div><h2>Plugin Library</h2><p>Tools installed for <strong>${escHtml(author.name || "Anonymous")}</strong>. They travel with this author, not just this device.</p></div><button class="m-cancel btn-quiet" title="Close">×</button></div><div class="plugin-grid">${Object.entries(PLUGINS).map(([id, p]) => `<section class="plugin-card ${pluginEnabled(id) ? "installed" : ""}"><div class="plugin-icon">${p.icon}</div><div class="plugin-copy"><div class="plugin-kicker">${p.kind} · ${p.status}</div><h3>${p.name}</h3><p>${p.description}</p>${id === "palette" && pluginEnabled(id) ? paletteWidget(author) : ""}</div>${p.status === "Ready" ? (id === "github" && pluginEnabled(id) ? `<div class="plugin-actions"><button data-github-settings class="btn-gold">Open Sync Settings</button><button data-plugin="${id}" class="btn-quiet">Uninstall</button></div>` : `<button data-plugin="${id}" class="${pluginEnabled(id) ? "btn-quiet" : "btn-gold"}">${pluginEnabled(id) ? "Uninstall" : "Install"}</button>`) : `<span class="plugin-soon">Coming soon</span>`}</section>`).join("")}</div><p class="plugin-foot">A plugin can add a page, format, or workflow without changing your manuscript files.</p></div>`;
  document.body.appendChild(bd);
  const close = () => { applyPluginAppearance(); bd.remove(); };
  bd.querySelector(".m-cancel").onclick = close;
  bd.querySelectorAll("[data-plugin]").forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.plugin;
    const installed = authorPlugins();
    const wasInstalled = installed.includes(id);
    if (wasInstalled) author.plugins = installed.filter((p) => p !== id);
    else installed.push(id);
    // Git backup covers the whole library, so removing the plugin must
    // actually stop it rather than just hiding the button.
    if (id === "github" && wasInstalled && library.history && library.history.git) {
      library.history.git = { ...library.history.git, enabled: false, autoPush: false };
    }
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    if (id === "storyMap" && currentTab === "outline") renderOutline();
    if (wasInstalled) {
      const card = btn.closest(".plugin-card");
      card.classList.remove("installed");
      card.querySelector(".palette-widget")?.remove();
      btn.textContent = "Install";
      btn.className = "btn-gold";
      toast(`${PLUGINS[id].name} removed for ${displayAuthor()}`);
      return;
    }
    close();
    if (id === "github") openSyncSettings();
    toast(`${PLUGINS[id].name} installed for ${displayAuthor()}`);
  });
  bd.querySelector("[data-github-settings]")?.addEventListener("click", () => {
    close();
    openSyncSettings();
  });
  const picker = bd.querySelector("[data-palette]");
  if (picker) picker.onchange = async () => {
    author.pluginPalette = picker.value;
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    const colors = paletteFor(author);
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = colors[input.dataset.paletteColor] || PALETTE_PRESETS.classic[input.dataset.paletteColor];
    });
  };
  bd.querySelector("[data-reset-palette]")?.addEventListener("click", async () => {
    author.pluginPalette = "classic";
    await window.neo.writeLibrary(library);
    applyPluginAppearance();
    picker.value = "classic";
    const colors = PALETTE_PRESETS.classic;
    bd.querySelectorAll("[data-palette-color]").forEach((input) => {
      input.value = colors[input.dataset.paletteColor];
    });
    toast("Returned to NEO’s default colors");
  });
  bd.querySelector("[data-open-palette-studio]")?.addEventListener("click", () => {
    close();
    openPaletteStudio();
  });
  bd.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}
$("#plugins-btn").onclick = openPlugins;
