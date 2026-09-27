'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {openNeo, canLaunch} = require('../helpers/renderer');
let launchable;
test.before(async () => { launchable = await canLaunch(); });
function skip(t) { if (!launchable) { t.skip('Chromium unavailable'); return true; } return false; }

test('GitHub setup stays separate from local saving and a failed first upload can be retried', async t => {
  if (skip(t)) return;
  const r = await openNeo({lib: {history: {enabled: true, intervalMinutes: 15}}, init: `
    let pushes = 0;
    api.connectGitRemote = async url => { calls.push(['connectGitRemote',url]); };
    api.pushGit = async () => { calls.push(['pushGit']); if (++pushes === 1) throw new Error('Sign in to GitHub'); return {lastPushAt:new Date().toISOString()}; };
  `});
  try {
    await r.menu({type:'plugins'});
    await r.page.click('[data-plugin="github"]');
    assert.equal(await r.page.locator('.plugin-modal').isVisible(), true);
    await r.page.getByRole('button',{name:'Open backup settings'}).click();
    await r.page.waitForFunction(() => !document.querySelector('#sy-git-connect').disabled);
    assert.equal(await r.page.locator('#sy-history-enabled').count(), 0);
    assert.equal(await r.page.locator('#sy-git-push').isVisible(), false);
    await r.page.fill('#sy-git-remote','https://github.com/writer/library.git');
    await r.page.click('#sy-git-connect');
    await r.page.waitForFunction(() => document.querySelector('#sy-git-status').textContent.includes('Sign in'));
    assert.equal(await r.page.locator('#git-connected').isVisible(),true);
    assert.equal((await r.lastCall('writeLibrary'))[1].history.intervalMinutes,15);
    await r.page.click('#sy-git-push');
    await r.page.waitForFunction(() => document.querySelector('#sy-git-status').textContent === 'Backup complete.');
    assert.match(await r.page.locator('#sy-git-last').textContent(),/Last successful backup/);
    await r.page.uncheck('#sy-git-enabled');
    await r.page.waitForFunction(() => !document.querySelector('#sy-git-enabled').disabled);
    assert.equal((await r.lastCall('writeLibrary'))[1].history.git.autoPush,false);
    await r.page.click('.github-settings-modal .m-ok');
    await r.menu({type:'syncSettings'});
    assert.equal(await r.page.locator('#sy-git-remote').count(),0);
    await r.page.uncheck('#sy-history-enabled');
    await r.page.click('.m-cancel');
    assert.equal(await r.page.evaluate(()=>library.history.enabled),true);
    assert.equal((await r.calls('pushGit')).length,2);
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('goals preview and book language respect Cancel, and Save applies only their own settings', async t => {
  if (skip(t)) return;
  const r=await openNeo();
  try {
    await r.openBook(); await r.menu({type:'stats'});
    assert.equal(await r.page.locator('#ra-voice, #st-language, #st-dayends').count(),0);
    await r.page.fill('#st-book','90000'); await r.page.fill('#st-daily','600');
    await r.page.click('[data-chart-mode="cumulative"]');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),0);
    await r.page.click('.m-cancel');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),0);
    await r.menu({type:'stats'}); await r.page.fill('#st-book','70000'); await r.page.click('.m-ok');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),70000);
    await r.menu({type:'bookSettings'}); await r.page.fill('#st-language','fr'); await r.page.keyboard.press('Escape');
    assert.equal(await r.page.evaluate(()=>NeoLanguage.manuscriptLanguage(book)),'en');
    await r.menu({type:'bookSettings'}); await r.page.fill('#st-language','not_a_tag'); await r.page.click('.m-ok');
    assert.match(await r.page.locator('.dialog-error').textContent(),/language tag/);
    await r.page.fill('#st-language','fr'); await r.page.click('.m-ok');
    assert.equal(await r.page.evaluate(()=>book.language),'fr');
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('preferences and voice previews do not save until requested', async t => {
  if(skip(t))return;
  const r=await openNeo({lib:{readAloudRate:1},init:`
    Object.defineProperty(window,'speechSynthesis',{value:{getVoices:()=>[],addEventListener(){},removeEventListener(){},cancel(){},speak(u){calls.push(['sample',u.rate]);}}});
  `});
  try {
    await r.menu({type:'preferences'}); await r.page.selectOption('#st-dayends','3'); await r.page.selectOption('#pref-writing-style','plotter'); await r.page.click('.m-cancel');
    assert.notEqual(await r.page.evaluate(()=>library.writingStyle),'plotter');
    await r.menu({type:'preferences'}); await r.page.selectOption('#st-dayends','3'); await r.page.selectOption('#pref-writing-style','plotter'); await r.page.click('.m-ok');
    assert.equal((await r.lastCall('writeLibrary'))[1].writingStyle,'plotter');
    await r.menu({type:'readAloudSettings'}); await r.page.fill('#ra-rate','1.5'); await r.page.click('#ra-test');
    assert.equal((await r.lastCall('sample'))[1],1.5);
    assert.equal(await r.page.evaluate(()=>library.readAloudRate),1);
    await r.page.click('.m-cancel');
    assert.equal(await r.page.evaluate(()=>library.readAloudRate),1);
    await r.menu({type:'readAloudSettings'}); await r.page.fill('#ra-rate','1.4'); await r.page.click('.m-ok');
    assert.equal((await r.lastCall('writeLibrary'))[1].readAloudRate,1.4);
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('settings actions remain in view in a small window', async t => {
  if(skip(t))return;
  const r=await openNeo({lib:{authors:[{id:'a1',name:'A. Writer',plugins:['palette']}]}});
  try {
    await r.page.setViewportSize({width:480,height:600});
    for (const type of ['syncSettings','preferences','plugins']) {
      await r.menu({type});
      const bounds=await r.page.locator('.settings-dialog').boundingBox();
      assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.y+bounds.height<=600);
      await r.page.keyboard.press('Escape');
      assert.equal(await r.page.locator('.settings-dialog').count(),0);
    }
    await r.page.evaluate(()=>NeoPlugins.call('palette','configure'));
    const footer=await r.page.locator('.palette-studio-save').boundingBox();
    assert.ok(footer.y+footer.height<=600);
    assert.equal(await r.page.locator('.palette-studio-screen .dialog-body').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});
