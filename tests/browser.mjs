import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.TEST_URL||'http://127.0.0.1:4173/gentle-r1-demo/';
fs.mkdirSync('test-results',{recursive:true});
const errors=[],requests=[];
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-features=Vulkan']});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',r=>{if(r.status()>=400)requests.push({url:r.url(),status:r.status()});});
page.on('console',message=>{if(message.type()==='error')console.log('BROWSER:',message.text());});
try {
  await page.goto(base,{waitUntil:'networkidle',timeout:120000});
  await page.waitForFunction(()=>window.__R1_DEBUG__?.app.loaded||document.querySelector('#status-text')?.textContent==='加载失败',null,{timeout:120000});
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
      if(await page.locator('#spring').isChecked()!==spring)await page.locator('label.toggle-row').click();
      const result=await page.evaluate(async ({spring})=>{
        const d=window.__R1_DEBUG__,s=d.app.sim;if(s.spring!==spring)throw Error('Spring toggle did not reach physics');s.forceLimit=10;s.reset();
        const result=await d.runSteps(1100);
        result.physicsTime=s.data.time;result.referenceFrame=s.frame;result.boot=s.lastObservation[0];
        return result;
      },{spring});
      assert.equal(result.steps,1100);assert.equal(result.fault,null);assert.ok(result.root[2]>.4);
      assert.ok(Math.abs(result.physicsTime-22)<1e-7);assert.equal(result.referenceFrame,99);assert.equal(result.boot,0);
      assert.ok(spring?result.peakForce>1:result.peakForce===0);
      cases.push({id,spring,...result});console.log('CASE',cases.at(-1));
    }
  }
  if(await page.locator('#spring').isChecked())await page.locator('label.toggle-row').click();
  // Independent WASM standing regression: fixed world camera, no foot anchoring.
  await page.selectOption('#motion','stand');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  const standing=await page.evaluate(async()=>{
    const d=window.__R1_DEBUG__,s=d.app.sim;s.reset();await d.runSteps(100);
    const ids=['left','right'].map(side=>s.bodyId(side+'_ankle_roll_link'));
    const positions=()=>ids.map(b=>Array.from(s.data.xpos.slice(3*b,3*b+3)));
    const before=positions();const result=await d.runSteps(2900);const after=positions();
    const ground=s.mj.mj_name2id(s.model,s.mj.mjtObj.mjOBJ_GEOM.value,'ground');
    const friction=Array.from({length:s.model.ngeom},(_,i)=>i).filter(g=>g===ground||(ids.includes(s.model.geom_bodyid[g])&&s.model.geom_contype[g]!==0)).map(g=>s.model.geom_friction[3*g]);
    return {...result,driftMm:before.map((p,i)=>Math.hypot(after[i][0]-p[0],after[i][1]-p[1])*1000),physicsDt:s.model.opt.timestep,friction,
      cone:s.model.opt.cone,impratio:s.model.opt.impratio,noslip:s.model.opt.noslip_iterations,cameraFollowsRoot:d.app.viewer.follow};
  });
  assert.equal(standing.steps,3000);assert.equal(standing.fault,null);assert.equal(standing.physicsDt,.001);
  assert.equal(standing.cone,1);assert.equal(standing.impratio,10);assert.equal(standing.noslip,20);
  assert.equal(standing.friction.length,3);assert.ok(standing.friction.every(mu=>mu===1));
  assert.ok(standing.driftMm[0]<20&&standing.driftMm[1]<15,JSON.stringify(standing));assert.equal(standing.cameraFollowsRoot,false);
  console.log('STANDING_60S',standing);
  // Normal UI operates the same engine; no test-only motion path.
  await page.click('#play');await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.steps>3005);
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),true);await page.click('#play');
  await page.click('#reset');await page.click('#play');await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.steps>=10);
  await page.click('#play');const paused=await page.evaluate(()=>window.__R1_DEBUG__.app.playing);assert.equal(paused,false);
  await page.click('#reset');await page.click('#push');
  await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.lastForce===10);
  await page.click('#play');assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),false);
  await page.click('#reset');
  // Find a genuine mesh intersection on the torso, then send real mouse events.
  const hit=await page.evaluate(()=>{
    const v=window.__R1_DEBUG__.app.viewer,c=v.renderer.domElement.getBoundingClientRect();
    for(let y=c.top+c.height*.4;y<c.bottom;y+=5)for(let x=c.left+c.width*.4;x<c.left+c.width*.65;x+=5){
      const h=v.pick({clientX:x,clientY:y});if(h&&h.object.userData.body===v.sim.torso)return {x,y};
    }
    return null;
  });
  assert.ok(hit,'Rendered torso must be pickable');await page.mouse.move(hit.x,hit.y);await page.mouse.down();
  const cameraBefore=await page.evaluate(()=>window.__R1_DEBUG__.app.viewer.camera.position.toArray());
  await page.mouse.move(hit.x+40,hit.y,{steps:3});
  assert.ok(await page.evaluate(()=>!!window.__R1_DEBUG__.app.sim.drag),'Drag must attach to physical body');
  const dragResult=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(5));assert.ok(dragResult.peakForce>0&&dragResult.peakForce<=30.000001);
  const cameraAfter=await page.evaluate(()=>window.__R1_DEBUG__.app.viewer.camera.position.toArray());
  assert.ok(Math.max(...cameraAfter.map((x,i)=>Math.abs(x-cameraBefore[i])))<1e-9,'Robot dragging must not orbit the camera');
  await page.mouse.up();assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.drag),null);
  await page.mouse.move(hit.x,hit.y);await page.mouse.down();
  await page.evaluate(()=>document.querySelector('#reset').click());await page.mouse.move(hit.x+20,hit.y);
  assert.deepEqual(await page.evaluate(()=>({drag:window.__R1_DEBUG__.app.sim.drag,enabled:window.__R1_DEBUG__.app.viewer.controls.enabled})),{drag:null,enabled:true});
  await page.mouse.up();
  const blank=await page.evaluate(()=>{const r=document.querySelector('#viewport canvas').getBoundingClientRect();return {x:r.left+r.width*.15,y:r.top+r.height*.5};});
  const oldCamera=await page.evaluate(()=>window.__R1_DEBUG__.app.viewer.camera.position.toArray());
  await page.mouse.move(blank.x,blank.y);await page.mouse.down();await page.mouse.move(blank.x+70,blank.y,{steps:6});await page.mouse.up();
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.drag),null);
  assert.notDeepEqual(await page.evaluate(()=>window.__R1_DEBUG__.app.viewer.camera.position.toArray()),oldCamera);
  await page.locator('#force-limit').fill('5');assert.equal(await page.locator('#force-value').innerText(),'5 N');
  await page.click('#about-button');assert.ok(await page.locator('#about').isVisible());await page.click('#close-about');
  await page.click('#ghost-button');assert.equal(await page.locator('#ghost-button').getAttribute('aria-pressed'),'true');
  await page.click('#ghost-button');
  await page.click('#reset');await page.screenshot({path:'test-results/desktop-final.png',fullPage:true});
  assert.equal(await page.locator('.intro,.topbar,footer,.metrics').count(),0);
  assert.equal(await page.locator('#drag-mode').count(),0);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  fs.writeFileSync('test-results/browser.json',JSON.stringify({status:'passed',url:base,maxAbsoluteActionError:maxError,cases,standing,
    interaction:{push10N:true,dragPeakForce:dragResult.peakForce,releaseClearsForce:true,robotDragWithoutModifier:true,blankDragRotatesCamera:true},consoleErrors:errors,failedResponses:requests},null,2));
  console.log('BROWSER_ACCEPTANCE_PASSED');
} catch(error){await page.screenshot({path:'test-results/failure.png',fullPage:true}).catch(()=>{});fs.writeFileSync('test-results/failure.json',JSON.stringify({error:error.stack,pageErrors:errors,failedResponses:requests},null,2));throw error;}finally{await browser.close();}
