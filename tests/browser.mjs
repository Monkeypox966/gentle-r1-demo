import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.TEST_URL||'http://127.0.0.1:4173/gentle-r1-demo/';
fs.mkdirSync('test-results',{recursive:true});
const errors=[],requests=[];
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-features=Vulkan']});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
page.on('console',message=>{if(message.type()==='error')console.log('BROWSER:',message.text());});
try {
  await page.goto(base,{waitUntil:'networkidle',timeout:120000});
  await page.waitForFunction(()=>window.__R1_DEBUG__?.app.loaded||document.querySelector('#status-text')?.textContent==='加载失败',{timeout:120000});
  const loaded=await page.evaluate(()=>({loaded:window.__R1_DEBUG__?.app.loaded,status:document.querySelector('#status-text').textContent,detail:document.querySelector('#loading-text').textContent}));
  assert.ok(loaded.loaded,JSON.stringify(loaded));
  console.log('READY',loaded);
  await page.waitForTimeout(500);
  await page.screenshot({path:'test-results/desktop.png',fullPage:true});
  const fixtures=JSON.parse(fs.readFileSync('tests/fixtures/policy.json'));
  const maxError=await page.evaluate(async cases=>{
    const sim=window.__R1_DEBUG__.app.sim;let max=0;
    for(const c of cases){const a=await sim.infer(Float32Array.from(c.observation));for(let i=0;i<24;i++)max=Math.max(max,Math.abs(a[i]-c.expected_action[i]));}
    return max;
  },fixtures);
  assert.ok(maxError<1e-5,`ONNX browser parity failed ${maxError}`);console.log('ONNX_PARITY',maxError);
  const cases=[];
  for(const id of ['stand','raise','reach']){
    await page.selectOption('#motion',id);await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
    for(const spring of [false,true]){
      const result=await page.evaluate(async ({spring})=>{
        const d=window.__R1_DEBUG__,s=d.app.sim;s.spring=spring;s.forceLimit=10;s.reset();
        return await d.runSteps(500);
      },{spring});
      assert.equal(result.steps,500);assert.equal(result.fault,null);assert.ok(result.root[2]>.4);
      assert.ok(spring?result.peakForce>1:result.peakForce===0);
      cases.push({id,spring,...result});console.log('CASE',cases.at(-1));
    }
  }
  // Normal UI operates the same engine; no test-only motion path.
  await page.click('#reset');await page.click('#play');await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.steps>=10);
  await page.click('#play');const paused=await page.evaluate(()=>window.__R1_DEBUG__.app.playing);assert.equal(paused,false);
  await page.click('#reset');await page.click('#push');
  await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.lastForce===10);
  await page.click('#play');assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),false);
  await page.click('#reset');await page.click('#drag-mode');
  // Find a genuine mesh intersection on the torso, then send real mouse events.
  const hit=await page.evaluate(()=>{
    const v=window.__R1_DEBUG__.app.viewer,c=v.renderer.domElement.getBoundingClientRect();
    for(let y=c.top+c.height*.4;y<c.bottom;y+=5)for(let x=c.left+c.width*.4;x<c.left+c.width*.65;x+=5){
      const h=v.pick({clientX:x,clientY:y});if(h&&h.object.userData.body===v.sim.torso)return {x,y};
    }
    return null;
  });
  assert.ok(hit,'Rendered torso must be pickable');await page.mouse.move(hit.x,hit.y);await page.mouse.down();
  await page.mouse.move(hit.x+40,hit.y,{steps:3});
  assert.ok(await page.evaluate(()=>!!window.__R1_DEBUG__.app.sim.drag),'Drag must attach to physical body');
  const dragResult=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(5));assert.ok(dragResult.peakForce>0&&dragResult.peakForce<=30.000001);
  await page.mouse.up();assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.drag),null);await page.click('#drag-mode');
  await page.locator('#force-limit').fill('5');assert.equal(await page.locator('#force-value').innerText(),'5 N');
  await page.click('#about-button');assert.ok(await page.locator('#about').isVisible());await page.click('#close-about');
  await page.click('#ghost-button');assert.equal(await page.locator('#ghost-button').getAttribute('aria-pressed'),'true');
  await page.click('#ghost-button');
  await page.click('#reset');await page.screenshot({path:'test-results/desktop-final.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  fs.writeFileSync('test-results/browser.json',JSON.stringify({status:'passed',url:base,maxAbsoluteActionError:maxError,cases,interaction:{push10N:true,dragPeakForce:dragResult.peakForce,releaseClearsForce:true},consoleErrors:errors,failedResponses:requests},null,2));
  console.log('BROWSER_ACCEPTANCE_PASSED');
} catch(error){await page.screenshot({path:'test-results/failure.png',fullPage:true}).catch(()=>{});fs.writeFileSync('test-results/failure.json',JSON.stringify({error:error.stack,pageErrors:errors,failedResponses:requests},null,2));throw error;}finally{await browser.close();}
