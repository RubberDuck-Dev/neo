'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {openNeo,canLaunch}=require('../helpers/renderer');
let launchable;test.before(async()=>{launchable=await canLaunch();});
const lib={authors:[{id:'a1',name:'A. Writer',plugins:['noteCards']}]};
const seed=`const originalMeta=api.readBookMeta; api.readBookMeta=async()=>({...await originalMeta(),chapterTitles:{c1:'Opening'},chapterNotes:{c1:'Meet the hero'},sectionNotes:{c1:[{id:'s1',text:'Written scene plan'},{id:'s2',text:'Unwritten scene'}]}});`;

test('cards and outline share titles, summaries, sections, chapter order, and safe deletion',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({lib,init:seed,chapters:{c1:'<p data-sec-id="s1">Already written prose.</p>',c2:'<p>The ending.</p>'}});
 try{
  await r.openBook();assert.equal(await r.page.locator('[data-tab="cards"]').count(),0);
  await r.page.click('[data-tab="outline"]');await r.page.click('[data-outline-view="cards"]');
  const card=r.page.locator('[data-card-id="c1"]');
  assert.equal(await card.locator('.card-more,.card-open,.card-heading').count(),0);
  assert.equal(await r.page.locator('#aux-paper .outline-view-toolbar').count(),0);
  assert.equal(await card.locator('.card-section').first().textContent(),'Meet the hero');
  assert.equal(await card.locator('.note-card-title').textContent(),'Opening');
  await card.locator('.note-card-title').fill('New opening');
  await card.locator('[data-section-id="s1"]').fill('Changed plan');await card.locator('[data-section-id="s2"]').fill('The unwritten scene changes');
  assert.equal(await r.page.locator('.chapter[data-id="c1"] .ch-title').textContent(),'New opening');
  assert.equal(await r.page.locator('.chapter-body p[data-sec-id="s1"]').textContent(),'Already written prose.');
  assert.equal(await r.page.locator('.ghost[data-sec-id="s2"]').textContent(),'The unwritten scene changes');
  await r.page.click('[data-outline-view="list"]');
  assert.equal(await r.page.locator('.add-card').isVisible(),false);
  assert.equal(await r.page.locator('.ol-chapter[data-ch-id="c1"] .ol-title').textContent(),'New opening');
  await r.page.locator('.ol-line[data-sec-id="s2"] .ol-text').fill('Edited in Outline');
  await r.page.keyboard.press('Control+Alt+KeyC');
  assert.equal(await card.locator('[data-section-id="s2"]').textContent(),'Edited in Outline');
  await card.locator('[data-section-id="s2"]').press('Enter');
  await card.locator('.card-section').last().fill('Another scene');
  const addedSection=await card.locator('.card-section').last().getAttribute('data-section-id');
  assert.equal(await r.page.locator(`.ghost[data-sec-id="${addedSection}"]`).textContent(),'Another scene');
  await card.locator('.card-section').last().fill(''); await card.locator('.card-section').last().press('Backspace');
  assert.equal(await r.page.locator(`.ghost[data-sec-id="${addedSection}"]`).count(),0);
  await card.locator('[data-section-id="s1"]').fill(''); await card.locator('[data-section-id="s1"]').press('Backspace');
  assert.equal(await r.page.locator('.chapter-body p[data-sec-id="s1"]').textContent(),'Already written prose.');
  await card.locator('.card-drag').press('Alt+ArrowDown');
  await r.page.waitForFunction(()=>book.chapterOrder[0]==='c2');
  assert.deepEqual(await r.page.locator('#chapters .chapter').evaluateAll(es=>es.map(e=>e.dataset.id)),['c2','c1']);
  await card.click({button:'right'});await r.page.getByRole('button',{name:'Delete chapter',exact:false}).click();
  await r.page.waitForFunction(()=>!book.chapterOrder.includes('c1'));
  assert.ok(await r.page.evaluate(()=>darlings.some(d=>d.html.includes('Already written prose.'))));
  await r.page.evaluate(()=>structuralUndo());
  assert.ok(await r.page.evaluate(()=>book.chapterOrder.includes('c1')));
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});

test('standalone legacy cards import once without changing existing chapters or losing originals',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({lib,init:String.raw`api.readJSON=async(b,n,f)=>n==='note-cards'?[{id:'old',title:'Saved card',body:'First section\nSecond section'}]:f;`});
 try{
  await r.openBook();await r.page.click('[data-tab="outline"]');
  assert.equal(await r.page.evaluate(()=>book.chapterOrder.length),2);
  await r.page.getByRole('button',{name:'Import saved cards'}).click();
  await r.page.waitForFunction(()=>book.legacyCardsImported);
  assert.equal(await r.page.evaluate(()=>book.chapterOrder.length),3);
  const added=await r.page.evaluate(()=>book.chapterOrder[2]);
  assert.deepEqual(await r.page.evaluate(id=>book.sectionNotes[id].map(s=>s.text),added),['First section','Second section']);
  await r.page.evaluate(()=>NeoPlugins.setEnabled('noteCards',false));await r.page.evaluate(()=>NeoPlugins.setEnabled('noteCards',true));
  assert.equal(await r.page.getByRole('button',{name:'Import saved cards'}).count(),0);
  assert.equal((await r.calls('writeJSON')).filter(c=>c[2]==='note-cards').length,0);
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
