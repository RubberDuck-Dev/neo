// NEO's spellchecker, in its own process. Parsing a Hunspell dictionary
// takes from a quarter second (English) to several seconds (French); done
// here, the writing room never feels it. main.js forks this with Electron's
// utilityProcess and talks to it with plain messages.
'use strict';

const fs = require('fs');
const path = require('path');
const nspell = require('nspell');

let spell = null;

function reply(msg, extra) {
  process.parentPort.postMessage({ id: msg.id, ...extra });
}

process.parentPort.on('message', (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') {
      const dict = {
        aff: fs.readFileSync(path.join(msg.dir, 'index.aff')),
        dic: fs.readFileSync(path.join(msg.dir, 'index.dic'))
      };
      const next = nspell(dict);
      for (const w of msg.custom || []) next.add(w);
      spell = next;
      reply(msg, { ok: true });
    } else if (msg.type === 'check') {
      const out = {};
      // dictionary still loading: report everything correct rather than crying wolf
      for (const w of msg.words || []) out[w] = spell ? spell.correct(w) : true;
      reply(msg, { ok: true, result: out });
    } else if (msg.type === 'suggest') {
      reply(msg, { ok: true, result: spell ? spell.suggest(msg.word).slice(0, 6) : [] });
    } else if (msg.type === 'add') {
      if (spell && typeof msg.word === 'string') spell.add(msg.word);
      reply(msg, { ok: true });
    } else {
      reply(msg, { ok: false, error: 'unknown message' });
    }
  } catch (err) {
    reply(msg, { ok: false, error: String(err && err.stack || err) });
  }
});
