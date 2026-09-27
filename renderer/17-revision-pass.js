"use strict";

/* ================================================================== */
/*  REVISION PASS                                                      */
/*  An editing lens, never a nag: nothing shows until the writer asks  */
/*  (Edit → Revision Pass), and Esc puts it away. Offline, no AI.      */
/*  Echoes      — the same word again within a few lines               */
/*  Filler      — words that usually add nothing (just, really, …)    */
/*  -ly adverbs — worth a second look, not a rule                      */
/*  Names       — a rare spelling of a name used elsewhere in the book */
/*  Painted with the CSS Highlight API, like the spellcheck pass.      */
/* ================================================================== */

let revisionOn = false;
let revisionScanned = new Set();
let revisionFlags = new Map(); // chId → [{ range, kind, word, note }]
let revisionIgnored = new Set(); // lowercase words the writer waved off this session
let revisionNames = new Map(); // variant → { canon, variantCount, canonCount }

const REVISION_ECHO_WINDOW = 40; // words
const REVISION_STOP = new Set(("a about above after again against all almost also although always am an and another any " +
  "are around as at back be because been before being below between both but by came can come could did do does doing done down " +
  "during each even ever every few for from get got had has have having he her here hers herself him himself his how i if in into " +
  "is it its itself just know like made make many may me might more most much must my myself never no nor not now of off on once " +
  "one only or other our ours out over own said same say says see she should so some still such than that the their theirs them " +
  "themselves then there these they thing things this those though through to too under until up upon us very was way we well were " +
  "what when where which while who whom why will with would yes yet you your yours yourself back look looked away eyes going went " +
  "into onto").split(" "));
const REVISION_FILLER = ["just", "really", "very", "quite", "rather", "somewhat", "actually", "basically", "literally",
  "suddenly", "simply", "totally", "completely", "definitely", "certainly", "truly", "seemingly", "began to", "started to",
  "seemed to", "sort of", "kind of", "a bit", "a little", "in order to"];
const REVISION_NOT_ADVERB = new Set(("only family early reply apply supply fly belly bully jelly rally ally holy ugly lovely " +
  "lonely friendly lively likely unlikely daily weekly monthly yearly hourly nightly silly chilly hilly curly burly surly costly " +
  "deadly elderly orderly oily woolly wily jolly folly holly lily sly butterfly dragonfly assembly anomaly italy july rely comply " +
  "imply multiply homily doily melancholy dally sully tally gully july emily molly sally kelly billy reilly ally gangly ghastly " +
  "ghostly godly heavenly homely kindly leisurely manly motherly fatherly brotherly sisterly neighborly portly prickly queenly " +
  "saintly scholarly shapely sickly smelly stately timely ugly unruly wobbly wrinkly bubbly cuddly giggly grisly grizzly " +
  "measly miserly niggardly northerly southerly easterly westerly pearly poly rascally squiggly steely stingy scaly bodily").split(" "));

function revisionCanon(text) {
  return text.toLowerCase().replace(/’/g, "'").replace(/'s$/, "");
}

// Collect the prose text nodes of a chapter body, skipping outline ghosts,
// placeholders and scene breaks — the same exclusions the spell pass uses.
function revisionTextNodes(el) {
  const nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const p = n.parentElement;
    if (p && p.closest(".scene-break, .ghost, .ph-mark")) continue;
    nodes.push(n);
  }
  return nodes;
}

// Capitalized words, noting which sit mid-sentence. A word counts as a name
// if it's ever capitalized mid-sentence, or never appears in lowercase.
function revisionNameTokens(text) {
  const out = [];
  const re = /[A-Z][a-z]+(?:[’'][a-z]+)?/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index).replace(/[\s"“”‘’'(—–-]+$/, "");
    out.push({ name: m[0].replace(/[’']s$/, ""), mid: !!before && !/[.!?…:]$/.test(before) });
  }
  return out;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Across the whole book: a spelling used far less often than a near-identical
// one ("Katharine" 2×, "Katherine" 40×) is probably a slip.
function buildRevisionNames() {
  const counts = new Map();
  const midSentence = new Set();
  const lowercase = new Set();
  const holder = document.createElement("div");
  for (const chId of book.chapterOrder) {
    holder.innerHTML = chapterHTML[chId] || "";
    holder.querySelectorAll(".ghost, .ph-mark, .scene-break").forEach((n) => n.remove());
    for (const p of holder.querySelectorAll("p")) {
      const text = p.textContent;
      for (const w of text.match(/\b[a-z][a-z’']*/g) || []) lowercase.add(w);
      for (const { name, mid } of revisionNameTokens(text)) {
        counts.set(name, (counts.get(name) || 0) + 1);
        if (mid) midSentence.add(name);
      }
    }
  }
  const names = [...counts.keys()].filter((n) => n.length >= 4 && (midSentence.has(n) || !lowercase.has(n.toLowerCase())));
  revisionNames = new Map();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a[0] !== b[0]) continue;
      const limit = Math.min(a.length, b.length) >= 7 ? 2 : 1;
      if (editDistance(a, b) > limit) continue;
      if (a + "s" === b || b + "s" === a) continue; // plural or possessive, not a variant
      const [rare, common] = counts.get(a) <= counts.get(b) ? [a, b] : [b, a];
      if (counts.get(common) < 3 || counts.get(rare) * 3 > counts.get(common)) continue;
      revisionNames.set(rare, { canon: common, variantCount: counts.get(rare), canonCount: counts.get(common) });
    }
  }
}

function revisionScan(el, chId) {
  if (!el || !revisionOn) return;
  revisionScanned.add(chId);
  const flags = [];
  const addFlag = (node, start, end, kind, word, note) => {
    try {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      flags.push({ range, kind, word, note });
    } catch { /* node changed underneath us */ }
  };

  const tokens = []; // every word in reading order, for echoes
  const capitalized = new Map();
  for (const node of revisionTextNodes(el)) {
    const text = node.data;
    const wordRe = /[A-Za-z][A-Za-z’']*/g;
    let m;
    while ((m = wordRe.exec(text))) {
      const word = m[0];
      const canon = revisionCanon(word);
      tokens.push({ node, start: m.index, end: m.index + word.length, word, canon });
      if (/^[A-Z]/.test(word)) capitalized.set(canon, (capitalized.get(canon) || 0) + 1);
      if (revisionIgnored.has(canon)) continue;
      if (/ly$/i.test(word) && word.length > 4 && !REVISION_NOT_ADVERB.has(canon) && !REVISION_FILLER.includes(canon)) {
        addFlag(node, m.index, m.index + word.length, "adverb", word, "An -ly adverb. Is there a stronger verb?");
      }
      const bare = word.replace(/[’']s$/, "");
      const variant = revisionNames.get(bare);
      if (variant && !revisionIgnored.has(bare.toLowerCase())) {
        addFlag(node, m.index, m.index + bare.length, "name", bare,
          `Used ${variant.variantCount}× in this book; “${variant.canon}” is used ${variant.canonCount}×.`);
      }
    }
    for (const phrase of REVISION_FILLER) {
      if (revisionIgnored.has(phrase)) continue;
      const re = new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "gi");
      while ((m = re.exec(text))) addFlag(node, m.index, m.index + m[0].length, "filler", m[0], "Often cuts cleanly.");
    }
  }

  // Echoes: a meaningful word (not a name) repeated within the window.
  const lastSeen = new Map();
  const echoed = new Set();
  const uses = new Map();
  for (const t of tokens) uses.set(t.canon, (uses.get(t.canon) || 0) + 1);
  tokens.forEach((t, i) => {
    if (t.canon.length < 4 || REVISION_STOP.has(t.canon) || revisionIgnored.has(t.canon)) return;
    const caps = capitalized.get(t.canon) || 0;
    if (caps > uses.get(t.canon) / 2) return; // mostly capitalized: a name or a title
    const prev = lastSeen.get(t.canon);
    if (prev !== undefined && i - prev <= REVISION_ECHO_WINDOW) {
      const gap = i - prev;
      for (const k of [prev, i]) {
        if (echoed.has(k)) continue;
        echoed.add(k);
        const e = tokens[k];
        addFlag(e.node, e.start, e.end, "echo", e.word, `“${t.word.toLowerCase()}” again within ${gap} words.`);
      }
    }
    lastSeen.set(t.canon, i);
  });

  revisionFlags.set(chId, flags);
  paintRevision();
}

const REVISION_KINDS = ["echo", "filler", "adverb", "name"];
function paintRevision() {
  if (!revisionOn) return;
  const lights = Object.fromEntries(REVISION_KINDS.map((k) => [k, new Highlight()]));
  for (const flags of revisionFlags.values()) {
    for (const f of flags) if (f.range.startContainer.isConnected) lights[f.kind].add(f.range);
  }
  for (const k of REVISION_KINDS) CSS.highlights.set("neo-rev-" + k, lights[k]);
}

function revisionCounts(chId) {
  const counts = { echo: 0, filler: 0, adverb: 0, name: 0 };
  for (const f of revisionFlags.get(chId) || []) counts[f.kind]++;
  return counts;
}

function revisionScanHere() {
  if (!revisionOn || currentTab !== "manuscript" || !currentChapterId) return;
  if (revisionScanned.has(currentChapterId)) return;
  revisionScan(spellElFor(currentChapterId), currentChapterId);
}

function scheduleRevisionRescan(chId, el) {
  clearTimeout(saveTimers["rev-" + chId]);
  saveTimers["rev-" + chId] = setTimeout(() => {
    if (revisionOn) revisionScan(el, chId);
  }, 700);
}

function toggleRevisionPass(force) {
  const next = typeof force === "boolean" ? force : !revisionOn;
  if (next === revisionOn) return;
  revisionOn = next;
  revisionScanned = new Set();
  revisionFlags = new Map();
  document.querySelector(".revision-menu")?.remove();
  if (!revisionOn) {
    for (const k of REVISION_KINDS) CSS.highlights.delete("neo-rev-" + k);
    toast("Revision pass off");
    return;
  }
  if (!book || currentTab !== "manuscript") {
    revisionOn = false;
    toast("Open a manuscript to run a revision pass");
    return;
  }
  buildRevisionNames();
  revisionScanHere();
  const c = revisionCounts(currentChapterId);
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  toast(`Revision pass: ${n(c.echo, "echo", "echoes")} · ${n(c.filler, "filler", "fillers")} · ${n(c.adverb, "-ly adverb", "-ly adverbs")} · ${n(c.name, "name slip", "name slips")} in this chapter. Right-click a mark to see why; Esc ends the pass.`, 7000);
}

// right-click a revision mark: say why, offer to ignore that word
document.addEventListener("contextmenu", (e) => {
  if (!revisionOn || e.defaultPrevented) return; // a spelling mark gets the spelling menu
  const body = e.target.closest && e.target.closest(".chapter-body");
  if (!body) return;
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!pos) return;
  const chId = body.closest(".chapter").dataset.id;
  const hits = (revisionFlags.get(chId) || []).filter((f) => {
    try { return f.range.isPointInRange(pos.startContainer, pos.startOffset); } catch { return false; }
  });
  if (!hits.length) return;
  e.preventDefault();
  document.querySelector(".revision-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spell-menu revision-menu";
  const labels = { echo: "Echo", filler: "Filler", adverb: "-ly adverb", name: "Name variant" };
  for (const f of hits) {
    const info = document.createElement("button");
    info.disabled = true;
    info.textContent = `${labels[f.kind]}: ${f.note}`;
    menu.appendChild(info);
  }
  const sep = document.createElement("div");
  sep.className = "sm-sep";
  menu.appendChild(sep);
  const word = hits[0].kind === "filler" ? hits[0].word.toLowerCase().replace(/\s+/g, " ") : revisionCanon(hits[0].word);
  const ignore = document.createElement("button");
  ignore.textContent = `Ignore “${hits[0].kind === "name" ? hits[0].word : word}” this session`;
  ignore.onclick = () => {
    menu.remove();
    revisionIgnored.add(word);
    revisionScanned = new Set();
    revisionScan(body, chId);
  };
  menu.appendChild(ignore);
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(e.clientY + 4, window.innerHeight - r.height - 10) + "px";
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close, true);
  };
  document.addEventListener("mousedown", close, true);
});
