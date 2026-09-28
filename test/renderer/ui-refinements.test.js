'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {openNeo,canLaunch}=require('../helpers/renderer');
let launchable;test.before(async()=>{launchable=await canLaunch();});
test('resolved notes reopen at their saved location and older notes go to their chapter',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo({chapters:{c1:'<p>Before <span class="ph-mark" data-sid="s1" contenteditable="false">⚑</span> after.</p>',c2:'<p>Ending.</p>'},init:`api.readJSON=async(b,n,f)=>n==='stickies'?[{id:'s1',chapterId:'c1',text:'Check this',resolved:false},{id:'old',chapterId:'c2',text:'Older note',resolved:true}]:f;`});
 try{
  await r.openBook();
  await r.page.evaluate(()=>{document.querySelector('#side-pane').classList.add('open');document.querySelector('#sticky-list').dataset.showAll='1';renderStickies();});
  await r.page.locator('[data-sid="s1"] .s-done').click();
  assert.equal(await r.page.locator('.ph-mark[data-sid="s1"]').count(),0);
  const resolvedText=await r.page.locator('.chapter[data-id="c1"] .chapter-body').textContent();
  await r.page.locator('[data-sid="s1"] .s-reopen').click();
  assert.equal(await r.page.locator('.ph-mark[data-sid="s1"]').count(),1);
  assert.equal(await r.page.evaluate(()=>stickies.find(s=>s.id==='s1').resolved),false);
  await r.page.locator('[data-sid="s1"] .s-done').click();
  assert.equal(await r.page.locator('.chapter[data-id="c1"] .chapter-body').textContent(),resolvedText);
  await r.page.click('[data-tab="notes"]');
  await r.page.evaluate(()=>document.querySelector('#side-pane').classList.add('open'));
  await r.page.locator('[data-sid="old"] .s-go').click();
  assert.equal(await r.page.evaluate(()=>currentTab),'manuscript');
  await r.page.locator('[data-sid="old"] .s-reopen').click();
  assert.equal(await r.page.locator('.chapter[data-id="c2"] .ph-mark[data-sid="old"]').count(),1);
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
test('shortcut guide wraps without overlapping and documents the view toggle',async t=>{
 if(!launchable)return t.skip('Chromium unavailable');
 const r=await openNeo();
 try{
  await r.menu({type:'help'});
  assert.match(await r.page.locator('.help-dialog').textContent(),/Ctrl\+Alt\+C/);
  for(const width of [1280,440]){
   await r.page.setViewportSize({width,height:740});
   const problems=await r.page.locator('.help-grid').evaluateAll(grids=>grids.flatMap(grid=>{
    const cells=[...grid.children],bad=[];
    for(let i=0;i<cells.length;i+=2){const a=cells[i].getBoundingClientRect(),b=cells[i+1].getBoundingClientRect();if(a.right>b.left+1&&a.bottom>b.top+1)bad.push(cells[i].textContent);}
    if(grid.scrollWidth>grid.clientWidth+1)bad.push('overflow');return bad;
   }));
   assert.deepEqual(problems,[]);
  }
  await r.page.getByRole('button',{name:'Done',exact:true}).click();
  assert.equal(await r.page.locator('.help-modal-backdrop').count(),0);
  assert.deepEqual(r.errors,[]);
 }finally{await r.close();}
});
