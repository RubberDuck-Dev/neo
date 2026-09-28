'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {openNeo,canLaunch}=require('../helpers/renderer');
let launchable; test.before(async()=>{launchable=await canLaunch();});
const init=`const readMeta=api.readBookMeta,writeMeta=api.writeBookMeta,readChapter=api.readChapter,writeChapter=api.writeChapter;
window.__disk={meta:null,chapters:{}};
api.readBookMeta=async id=>structuredClone(window.__disk.meta || await readMeta(id));
api.writeBookMeta=async(id,meta)=>{window.__disk.meta=structuredClone(meta);await writeMeta(id,meta);return new Date().toISOString();};
api.readChapter=async(b,id)=>id in window.__disk.chapters?window.__disk.chapters[id]:readChapter(b,id);
api.writeChapter=async(b,id,html)=>{window.__disk.chapters[id]=html;return writeChapter(b,id,html);};`;
test('idle flush skips unchanged chapters; remote-only changes refresh without rewriting them',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({init});
 try{
  await r.openBook();
  await r.page.evaluate(async()=>{flushAllSaves();await waitForBookWrites();window.__chapterWriteCount=window.__calls.filter(c=>c[0]==='writeChapter').length;flushAllSaves();await waitForBookWrites();});
  assert.equal((await r.calls('writeChapter')).length,await r.page.evaluate(()=>window.__chapterWriteCount));
  await r.page.evaluate(()=>{window.__disk.chapters.c1='<p>Another device wrote this.</p>';});
  await r.page.evaluate(()=>refreshFromDisk());
  assert.equal(await r.page.locator('.chapter[data-id="c1"] .chapter-body').textContent(),'Another device wrote this.');
  assert.equal((await r.calls('writeChapter')).filter(c=>c[1]==='c1').length,0);
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
test('simultaneous edits retain local prose and copy remote prose into a following chapter',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({init});
 try{
  await r.openBook();
  await r.page.evaluate(()=>{chapterHTML.c1='<p>My version.</p>';dirtyChapters.add('c1');window.__disk.chapters.c1='<p>Their version.</p>';});
  await r.page.evaluate(()=>refreshFromDisk());
  const state=await r.page.evaluate(()=>({order:book.chapterOrder,html:structuredClone(chapterHTML),disk:structuredClone(window.__disk.chapters)}));
  assert.equal(state.order.length,3);
  assert.equal(state.html.c1,'<p>My version.</p>');
  assert.equal(state.html[state.order[1]],'<p>Their version.</p>');
  assert.equal(state.disk.c1,'<p>My version.</p>');
  assert.equal(state.disk[state.order[1]],'<p>Their version.</p>');
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});

test('remote chapter metadata refreshes while preserving the current screen',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({init});
 try{
  await r.openBook(); await r.page.click('[data-tab="outline"]');
  await r.page.evaluate(async()=>{flushAllSaves();await waitForBookWrites();window.__disk.meta.chapterTitles={c1:'Remote title'};});
  await r.page.evaluate(()=>refreshFromDisk());
  assert.equal(await r.page.evaluate(()=>currentTab),'outline');
  assert.equal(await r.page.locator('.ol-chapter[data-ch-id="c1"] .ol-title').textContent(),'Remote title');
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
