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

test('goals preview and publishing language respect Cancel, and Save applies only their own settings', async t => {
  if (skip(t)) return;
  const r=await openNeo();
  try {
    await r.openBook(); await r.menu({type:'stats'});
    assert.equal(await r.page.locator('#ra-voice, #pub-language, #st-dayends').count(),0);
    await r.page.fill('#st-book','90000'); await r.page.fill('#st-daily','600');
    await r.page.click('[data-chart-mode="cumulative"]');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),0);
    await r.page.click('.m-cancel');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),0);
    await r.menu({type:'stats'}); await r.page.fill('#st-book','70000'); await r.page.click('.m-ok');
    assert.equal(await r.page.evaluate(()=>book.wordGoal),70000);
    await r.menu({type:'publishingDetails'}); await r.page.selectOption('#pub-language','fr'); await r.page.keyboard.press('Escape');
    assert.equal(await r.page.evaluate(()=>NeoLanguage.manuscriptLanguage(book)),'en');
    await r.menu({type:'publishingDetails'}); await r.page.selectOption('#pub-language','other'); await r.page.fill('#pub-language-other','not_a_tag'); await r.page.click('.pub-modal .m-ok');
    assert.match(await r.page.locator('.pub-book-language .dialog-error').textContent(),/language/);
    await r.page.selectOption('#pub-language','fr'); await r.page.click('.pub-modal .m-ok');
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

test('enabled GitHub appears as a saving tab without losing local drafts', async t => {
  if(skip(t))return;
  const r=await openNeo({lib:{plugins:{github:true}}});
  try {
    await r.menu({type:'syncSettings'});
    await r.page.selectOption('#sy-history-interval','30');
    const bounds = await r.page.locator('.settings-dialog').boundingBox();
    await r.page.evaluate(() => { window.__savingBackdrop = document.querySelector('.modal-backdrop'); });
    await r.page.getByRole('tab',{name:'GitHub backup'}).click();
    assert.deepEqual(await r.page.locator('.settings-dialog').boundingBox(),bounds);
    assert.ok(await r.page.evaluate(() => window.__savingBackdrop === document.querySelector('.modal-backdrop')));
    assert.equal(await r.page.locator('.settings-dialog').count(),1);
    assert.equal(await r.page.getByRole('tab',{name:'GitHub backup'}).getAttribute('aria-selected'),'true');
    assert.equal(await r.page.locator('#sy-git-remote').count(),1);
    await r.page.getByRole('tab',{name:'Local saving'}).click();
    assert.deepEqual(await r.page.locator('.settings-dialog').boundingBox(),bounds);
    assert.equal(await r.page.locator('#sy-history-interval').inputValue(),'30');
    await r.page.click('.m-ok');
    assert.equal((await r.lastCall('writeLibrary'))[1].history.intervalMinutes,30);
    await r.page.evaluate(()=>NeoPlugins.setEnabled('github',false));
    await r.menu({type:'syncSettings'});
    assert.equal(await r.page.getByRole('tab',{name:'GitHub backup'}).count(),0);
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('backdrop cancels only the top popup and preserves cleanup and unsaved preferences', async t => {
  if(skip(t))return;
  const r=await openNeo();
  try {
    await r.menu({type:'preferences'});
    await r.page.selectOption('#pref-writing-style','plotter');
    await r.page.locator('.dialog-head h2').click();
    assert.equal(await r.page.locator('.settings-dialog').count(),1);
    await r.page.evaluate(()=> { optionModal('Test choice','Choose or cancel', [{label:'Choose',value:'yes'}]).then(choice=>window.__choice=choice); });
    await r.page.mouse.click(2,2);
    await r.page.waitForFunction(()=>window.__choice===null);
    assert.equal(await r.page.locator('.settings-dialog').count(),1);
    await r.page.mouse.click(2,2);
    assert.equal(await r.page.locator('.settings-dialog').count(),0);
    assert.notEqual(await r.page.evaluate(()=>library.writingStyle),'plotter');
    await r.menu({type:'publishingDetails'}); await r.page.mouse.click(2,2);
    assert.equal(await r.page.locator('.pub-modal').count(),0);
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('upstream focus modes follow clicks, arrows, and the moving end of a selection', async t => {
  if(skip(t))return;
  const r=await openNeo({chapters:{c1:'<p>First sentence. <em>Second sentence.</em></p><p>Another paragraph.</p><p>Last paragraph.</p>',c2:'<p>Next chapter.</p>'}});
  try {
    await r.openBook();
    const first=r.page.locator('.chapter[data-id="c1"] .chapter-body p').first();
    const original=await first.innerHTML();
    await first.click(); await r.page.keyboard.press('Home');
    await r.menu({type:'focusCycle'});
    await r.page.waitForFunction(()=>CSS.highlights.get('neo-focus') && [...CSS.highlights.get('neo-focus')][0].toString().startsWith('First'));
    await r.page.keyboard.press('ArrowDown');
    await r.page.waitForFunction(()=>[...CSS.highlights.get('neo-focus')][0].toString()==='Another paragraph.');
    await r.page.keyboard.press('Shift+ArrowDown');
    await r.page.waitForFunction(()=>[...CSS.highlights.get('neo-focus')][0].toString()==='Last paragraph.');
    await first.click(); await r.page.keyboard.press('Home'); await r.menu({type:'focusCycle'});
    await r.page.waitForFunction(()=>[...CSS.highlights.get('neo-focus')][0].toString()==='First sentence.');
    for(let i=0;i<17;i++)await r.page.keyboard.press('ArrowRight');
    await r.page.waitForFunction(()=>[...CSS.highlights.get('neo-focus')][0].toString()==='Second sentence.');
    assert.equal(await first.innerHTML(),original);
    await r.menu({type:'focusCycle'});
    assert.equal(await r.highlight('neo-focus'),null);
    assert.equal(await r.page.locator('.focus-cap').count(),0);
    assert.equal((await r.lastCall('writeLibrary'))[1].focus,'off');
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('upstream editor fixes preserve outline text, Notes punctuation, and export metadata', async t => {
  if(skip(t))return;
  const r=await openNeo();
  try {
    await r.openBook();
    await r.page.click('[data-tab="notes"]');
    await r.page.click('#aux-editor'); await r.page.keyboard.type('Hello--there...');
    assert.match(await r.page.locator('#aux-editor').textContent(),/Hello—there…/);
    await r.page.click('[data-tab="outline"]');
    const line=r.page.locator('.ol-chapter .ol-text').first();
    await line.fill('Keep this chapter'); await r.page.keyboard.press('Home'); await r.page.keyboard.press('Enter');
    const order=await r.page.evaluate(()=>book.chapterOrder);
    assert.notEqual(order[0],'c1'); assert.equal(order[1],'c1');
    assert.equal(await r.page.evaluate(()=>book.chapterTitles.c1),'Keep this chapter');
    const output=await r.page.evaluate(()=>{
      const d={title:'<b>Title</b> *test*',author:'A & B',subtitle:'[subtitle]',sections:[{heading:'<Chapter>',paras:[]}]};
      return {html:buildHtml(d),md:buildMd(d)};
    });
    assert.ok(output.html.includes('&lt;b&gt;Title&lt;/b&gt;'));
    assert.ok(output.html.includes('&lt;Chapter&gt;'));
    assert.ok(output.md.includes('\\*test\\*'));
    assert.deepEqual(r.errors,[]);
  } finally { await r.close(); }
});

test('upstream author moves can be undone without losing shelf membership', async t => {
  if(skip(t))return;
  const r=await openNeo({lib:{authors:[{id:'a1',name:'A. Writer'},{id:'a2',name:'Other'}],shelves:[{id:'s1',name:'WIP',authorId:'a1',bookIds:['book-1']},{id:'s2',name:'Other shelf',authorId:'a2',bookIds:[]}]}});
  try {
    await r.page.evaluate(()=>moveBookToAuthor('book-1','a2'));
    let saved=(await r.lastCall('writeLibrary'))[1];
    assert.deepEqual(saved.shelves.find(s=>s.id==='s2').bookIds,['book-1']);
    await r.page.keyboard.press('Escape');
    await r.page.waitForFunction(()=>library.shelves.find(s=>s.id==='s1').bookIds.includes('book-1'));
    saved=(await r.lastCall('writeLibrary'))[1];
    assert.deepEqual(saved.shelves.find(s=>s.id==='s1').bookIds,['book-1']);
    assert.deepEqual(saved.shelves.find(s=>s.id==='s2').bookIds,[]);
    assert.deepEqual(r.errors,[]);
  }finally{await r.close();}
});
