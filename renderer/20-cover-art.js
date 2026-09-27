"use strict";

/* ================================================================== */
/*  COVER ART SETTINGS (File → Cover Art…)                             */
/* ================================================================== */

// One key per provider. The brief and the painting always come from the
// same provider, so a writer only ever needs one account.
const COVER_PROVIDERS = {
  openai: {
    name: "OpenAI",
    keyHint: "sk-…",
    where: "platform.openai.com → API keys",
    text: "gpt-5-mini",
    image: "gpt-image-1-mini",
    quality: true,
    cost: "a few cents a picture",
  },
};
// Key formats change under us, so the only test is "one token, long enough" —
// the provider does the rest.
const looksLikeKey = (k) => /^\S{20,}$/.test(k);
const coverSettings = () => library.coverArt || {};
const coverProvider = () =>
  COVER_PROVIDERS[coverSettings().provider]
    ? coverSettings().provider
    : "openai";

function openCoverArt() {
  const cs = coverSettings();
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const provOptions = Object.entries(COVER_PROVIDERS)
    .map(
      ([id, p]) =>
        `<option value="${id}"${coverProvider() === id ? " selected" : ""}>${p.name}</option>`,
    )
    .join("");
  bd.innerHTML = `
    <div class="modal" style="width:540px">
      <h2 style="font-size:17px">Cover art</h2>
      <p>Every book gets a cover on the shelf: an abstract with the title set in type. With an OpenAI key, NEO can also read a story once it passes ${PAINT_AT.toLocaleString()} words and paint a cover from the text. Paintings stay on your shelf — exports never include them.</p>
      <div class="stats-row">
        <select id="ca-provider" hidden>${provOptions}</select>
        <label class="st-check"><input id="ca-auto" type="checkbox"${cs.auto === false ? "" : " checked"}/> paint at ${PAINT_AT.toLocaleString()} words</label>
      </div>
      <div class="stats-row st-covers">
        <label>API key <input id="ca-key" type="password" autocomplete="off" spellcheck="false" style="width:300px"/></label>
      </div>
      <p class="soft" id="ca-note" style="margin:-6px 0 12px;font-size:12px"></p>
      <details class="st-advanced">
        <summary class="soft">Models</summary>
        <div class="stats-row">
          <label>Brief <input id="ca-tmodel" type="text" spellcheck="false"/></label>
          <label>Paint <input id="ca-imodel" type="text" spellcheck="false"/></label>
          <label id="ca-quality-wrap">Quality
            <select id="ca-quality">
              ${["low", "medium", "high"].map((q) => `<option value="${q}"${(cs.quality || "medium") === q ? " selected" : ""}>${q}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="soft" style="font-size:12px;margin:0 0 6px">Leave blank for NEO\u2019s defaults. Names drift; if a provider retires one, NEO tries its own list before giving up.</p>
      </details>
      <div style="text-align:right;margin-top:14px">
        <button class="m-cancel btn-quiet" style="margin-right:10px">Cancel</button>
        <button class="m-ok btn-gold">Save</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  const sel = bd.querySelector("#ca-provider");
  const key = bd.querySelector("#ca-key");
  const note = bd.querySelector("#ca-note");
  const models = cs.models || {};
  // per-provider fields: key placeholder, stored model overrides, quality
  const showProvider = async () => {
    const id = sel.value,
      p = COVER_PROVIDERS[id];
    key.value = "";
    key.placeholder = `${p.name} key (${p.keyHint})`;
    bd.querySelector("#ca-tmodel").value =
      (models[id] && models[id].text) || "";
    bd.querySelector("#ca-tmodel").placeholder = p.text;
    bd.querySelector("#ca-imodel").value =
      (models[id] && models[id].image) || "";
    bd.querySelector("#ca-imodel").placeholder = p.image;
    bd.querySelector("#ca-quality-wrap").style.display = p.quality
      ? ""
      : "none";
    const has = await window.neo.hasSecret(id);
    if (sel.value !== id) return;
    note.textContent = has
      ? `A ${p.name} key is saved, encrypted, outside your library folder. Paste a new one to replace it, or type \u201cremove\u201d to forget it.`
      : `Get a key at ${p.where} (${p.cost}). It\u2019s stored encrypted on this computer and only ever sent to ${p.name}.`;
  };
  sel.onchange = showProvider;
  showProvider();
  const done = () => bd.remove();
  bd.querySelector(".m-cancel").onclick = done;
  bd.querySelector(".m-ok").onclick = async () => {
    const id = sel.value,
      p = COVER_PROVIDERS[id];
    const k = key.value.trim();
    if (k === "remove") await window.neo.setSecret(id, "");
    else if (k && !looksLikeKey(k)) {
      toast(
        `That doesn\u2019t look like an API key (${p.name} keys look like ${p.keyHint}) \u2014 not saved`,
        6000,
      );
      return;
    } else if (k) await window.neo.setSecret(id, k);
    models[id] = {
      text: bd.querySelector("#ca-tmodel").value.trim() || undefined,
      image: bd.querySelector("#ca-imodel").value.trim() || undefined,
    };
    library.coverArt = {
      provider: id,
      auto: bd.querySelector("#ca-auto").checked,
      quality: bd.querySelector("#ca-quality").value,
      models,
    };
    await window.neo.writeLibrary(library);
    done();
    if (!(await window.neo.hasSecret(id)))
      toast(`Saved. Add a ${p.name} key to start painting.`, 5000);
  };
  bd.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done();
    }
  });
  key.focus();
}
