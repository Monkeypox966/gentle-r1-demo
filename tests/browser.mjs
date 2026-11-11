import {chromium} from '@playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {verifyPolicySwitching} from './policy-browser.mjs';
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
  assert.ok(await page.locator('#interaction-help').isVisible(),'The interaction hint must appear once resources are ready');
  assert.ok((await page.locator('#interaction-help').innerText()).includes('感受柔顺。'));
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),false);
  await page.waitForTimeout(700);await page.screenshot({path:'test-results/interaction-help.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>{const r=document.querySelector('#interaction-help').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
  await page.screenshot({path:'test-results/interaction-help-mobile.png',fullPage:true});
  await page.locator('#close-interaction-help').click();await page.locator('#interaction-help').waitFor({state:'hidden'});
  await page.setViewportSize({width:1440,height:1050});
  assert.equal(await page.locator('#motion option').count(),7);
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
    assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.motionId),id,`UI must activate ${id}, not silently keep the previous reference`);
    assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.motions.get(window.__R1_DEBUG__.app.sim.motionId).name),id);
    for(const spring of [false,true]){
      if(await page.locator('#spring').isChecked()!==spring)await page.locator('label.toggle-row').click();
      const pose=await page.evaluate(async ({spring})=>{
        const d=window.__R1_DEBUG__,s=d.app.sim;if(s.spring!==spring)throw Error('Spring toggle did not reach physics');s.forceLimit=10;s.reset();
        const first=await d.runSteps(250);
        const names=['left_shoulder_pitch_joint','right_shoulder_pitch_joint','left_elbow_joint','right_elbow_joint'];
        const indices=names.map(n=>s.config.physical_joint_names.indexOf(n));
        return {active:s.motionId,peakForce:first.peakForce,reference:indices.map(i=>s.referenceData.qpos[s.qids[i]]),
          measured:indices.map(i=>s.physicalQ()[i]),observation:indices.map(i=>s.lastObservation[23+i])};
      },{spring});
      assert.equal(pose.active,id);
      for(let i=0;i<4;i++)assert.ok(Math.abs(pose.reference[i]-pose.observation[i])<1e-6,'Selected arm targets must actually enter the policy observation');
      if(!spring&&id!=='stand')await page.screenshot({path:`test-results/motion-${id}.png`,fullPage:true});
      const result=await page.evaluate(async()=>{
        const d=window.__R1_DEBUG__,s=d.app.sim;
        const result=await d.runSteps(850);
        result.physicsTime=s.data.time;result.referenceFrame=s.frame;result.boot=s.lastObservation[0];
        return result;
      });
      result.peakForce=Math.max(result.peakForce,pose.peakForce);
      assert.equal(result.steps,1100);assert.equal(result.fault,null);assert.ok(result.root[2]>.4);
      assert.ok(Math.abs(result.physicsTime-22)<1e-7);assert.equal(result.referenceFrame,99);assert.equal(result.boot,0);
      assert.ok(spring?result.peakForce>1:result.peakForce===0);
      cases.push({id,spring,pose,...result});console.log('CASE',cases.at(-1));
    }
  }
  for(const spring of [false,true]){
    const baseline=cases.find(c=>c.id==='stand'&&c.spring===spring).pose.measured;
    for(const id of ['raise','reach']){
      const p=cases.find(c=>c.id===id&&c.spring===spring).pose;
      assert.ok(Math.abs(p.measured[0]-baseline[0])>.25&&Math.abs(p.measured[1]-baseline[1])>.25,`${id}: both real shoulders must move relative to standing`);
    }
    const raise=cases.find(c=>c.id==='raise'&&c.spring===spring).pose.measured;
    const reach=cases.find(c=>c.id==='reach'&&c.spring===spring).pose.measured;
    assert.ok(Math.max(...raise.map((x,i)=>Math.abs(x-reach[i])))>.1,'Raise and reach must produce distinct physical arm poses');
  }
  if(await page.locator('#spring').isChecked())await page.locator('label.toggle-row').click();
  const conditionedMotionPoses=[];
  for(const force of [5,15])for(const id of ['raise','reach']){
    await page.locator('#force-limit').fill(String(force));await page.selectOption('#motion',id);
    await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
    const p=await page.evaluate(async()=>{
      const d=window.__R1_DEBUG__,s=d.app.sim;s.reset();await d.runSteps(250);
      const indices=['left','right'].map(side=>s.config.physical_joint_names.indexOf(side+'_shoulder_pitch_joint'));
      return {active:s.motionId,force:s.forceLimit,shoulders:indices.map(i=>s.physicalQ()[i]),fault:s.fault};
    });
    assert.equal(p.active,id);assert.equal(p.force,force);assert.equal(p.fault,null);
    assert.ok(p.shoulders.every(q=>q<.1),'Both shoulders must move at the end points of the force-conditioning range');
    conditionedMotionPoses.push(p);
  }
  await page.locator('#force-limit').fill('10');
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
  const dynamic=[];
  for(const id of ['wave','twist','squat','walk'])for(const push of [false,true]){
    await page.selectOption('#motion',id);await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
    const result=await page.evaluate(async({id,push})=>{
      const d=window.__R1_DEBUG__,s=d.app.sim;s.reset();
      if(s.motionId!==id)throw Error('Dynamic motion did not activate');
      const feet=['left','right'].map(side=>s.bodyId(side+'_ankle_roll_link'));
      const trace=[];let peakForce=0;
      for(let i=0;i<44;i++){
        if(push&&i===8)s.push();
        const r=await d.runSteps(25);peakForce=Math.max(peakForce,r.peakForce);
        if(s.time>=2)trace.push({t:s.time,root:s.root,feet:feet.map(b=>Array.from(s.data.xpos.slice(b*3,b*3+3))),q:Array.from(s.physicalQ()),
          ref:s.motions.get(id).joint_pos[s.frame],referenceRoot:Array.from(s.referenceData.qpos.slice(0,3))});
      }
      const range=values=>Math.max(...values)-Math.min(...values);
      const names=s.config.physical_joint_names;
      const qRange=name=>range(trace.map(f=>f.q[names.indexOf(name)]));
      return {id,push,active:s.motionId,steps:s.steps,fault:s.fault,peakForce,root:s.root,cycles:s.cycles,
        cameraFollowsRoot:d.app.viewer.follow,
        jointRmse:Math.sqrt(trace.reduce((total,f)=>total+f.q.slice(0,24).reduce((sum,q,i)=>sum+(q-f.ref[i])**2,0),0)/(trace.length*24)),
        rootHeightRange:range(trace.map(f=>f.root[2])),rootNetTravel:Math.hypot(...s.root.slice(0,2)),
        feetHeightRange:feet.map((_,i)=>range(trace.map(f=>f.feet[i][2]))),
        kneeRange:['left','right'].map(side=>qRange(side+'_knee_joint')),
        shoulderRange:['left','right'].map(side=>qRange(side+'_shoulder_pitch_joint')),
        waistRange:qRange('waist_yaw_joint'),trace};
    },{id,push});
    assert.equal(result.active,id);assert.equal(result.steps,1100);assert.equal(result.cycles,2);assert.equal(result.fault,null);
    assert.ok(result.jointRmse<.18,JSON.stringify({...result,trace:undefined}));
    assert.equal(result.peakForce,push?10:0);
    if(id==='walk'){
      assert.equal(result.cameraFollowsRoot,true);
      assert.ok(result.rootNetTravel>1.5,'Walking must physically advance, not stand or shuffle in place');
      assert.ok(result.feetHeightRange.every(h=>h>.025),'Both physical feet must lift');
      // Reference is at x=3.96m after two seams, rather than teleporting to 0.
      assert.ok(result.trace.at(-1).referenceRoot[0]>3.9);
    }else assert.equal(result.cameraFollowsRoot,false);
    if(id==='squat')assert.ok(result.rootHeightRange>.035&&result.kneeRange.every(x=>x>.15));
    if(id==='wave')assert.ok(result.shoulderRange.every(x=>x>.25));
    if(id==='twist')assert.ok(result.waistRange>.35);
    console.log('DYNAMIC',{...result,trace:undefined});dynamic.push(result);
    if(!push){
      await page.click('#home-camera');await page.waitForTimeout(100);
      await page.screenshot({path:`test-results/dynamic-${id}.png`,fullPage:true});
    }
  }
  // Real pointer input while the physical robot is walking, followed by
  // continued tracking after release (not just a static drag attachment).
  await page.evaluate(async()=>{const d=window.__R1_DEBUG__;d.app.sim.reset();await d.runSteps(100);d.app.viewer.home();});
  await page.waitForTimeout(200);
  const walkingHit=await page.evaluate(()=>{
    const v=window.__R1_DEBUG__.app.viewer,c=v.renderer.domElement.getBoundingClientRect();
    for(const mesh of v.meshes.filter(m=>v.sim.wrists.includes(m.userData.body))){
      const p=mesh.position.clone().project(v.camera),x=c.left+(p.x+1)*c.width/2,y=c.top+(1-p.y)*c.height/2;
      const hit=v.pick({clientX:x,clientY:y});if(hit&&v.sim.wrists.includes(hit.object.userData.body))return {x,y,body:hit.object.userData.body};
    }
    for(let y=c.top+c.height*.35;y<c.bottom;y+=5)for(let x=c.left+c.width*.35;x<c.left+c.width*.7;x+=5){
      const hit=v.pick({clientX:x,clientY:y});if(hit&&hit.object.userData.body===v.sim.torso)return {x,y,body:hit.object.userData.body};
    }
    return null;
  });
  assert.ok(walkingHit,'The moving robot must remain visible and pickable');
  await page.mouse.move(walkingHit.x,walkingHit.y);await page.mouse.down();
  await page.mouse.move(walkingHit.x+8,walkingHit.y,{steps:3});
  const walkingDrag=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(10));
  assert.ok(walkingDrag.peakForce>0&&walkingDrag.peakForce<=30.000001);assert.equal(walkingDrag.fault,null);
  await page.mouse.up();
  const walkingRecovery=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(90));
  assert.equal(walkingRecovery.fault,null);assert.equal(walkingRecovery.force,0);assert.ok(walkingRecovery.root[0]>.3);
  await page.selectOption('#motion','stand');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  // Normal UI operates the same engine; no test-only motion path.
  await page.click('#play');await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.steps>5);
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),true);await page.click('#play');
  await page.click('#play');await page.selectOption('#motion','raise');
  await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  assert.deepEqual(await page.evaluate(()=>({motion:window.__R1_DEBUG__.app.sim.motionId,playing:window.__R1_DEBUG__.app.playing})),{motion:'raise',playing:true});
  await page.click('#play');
  await page.click('#reset');await page.click('#play');await page.waitForFunction(()=>window.__R1_DEBUG__.app.sim.steps>=10);
  await page.click('#play');const paused=await page.evaluate(()=>window.__R1_DEBUG__.app.playing);assert.equal(paused,false);
  await page.click('#reset');await page.click('#push');
  // The push lasts only .25s. A slow software-rendering RAF can miss its
  // instantaneous value; check the real UI's retained force samples instead.
  await page.waitForFunction(()=>window.__R1_DEBUG__.app.forceHistory.includes(10),null,{polling:20});
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
  // A separate page injects network failures/reordering; positive physics
  // evidence above always uses the actual unmodified application assets.
  const faultPage=await browser.newPage({viewport:{width:1100,height:900}}),faultErrors=[];
  faultPage.on('pageerror',error=>faultErrors.push(error.message));
  await faultPage.goto(base,{waitUntil:'networkidle',timeout:120000});
  await faultPage.waitForFunction(()=>window.__R1_DEBUG__?.app.loaded,null,{timeout:120000});
  assert.ok(await faultPage.locator('#interaction-help').isVisible());await faultPage.keyboard.press('Escape');await faultPage.locator('#interaction-help').waitFor({state:'hidden'});
  const raiseFile=await faultPage.evaluate(()=>window.__R1_DEBUG__.app.sim.config.motions.find(m=>m.id==='raise').file);
  const pattern='**/'+raiseFile;
  await faultPage.route(pattern,route=>route.abort('failed'));
  await faultPage.selectOption('#motion','raise');await faultPage.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  const rollback=await faultPage.evaluate(()=>({active:window.__R1_DEBUG__.app.sim.motionId,selected:document.querySelector('#motion').value,status:document.querySelector('#status-text').textContent,playing:window.__R1_DEBUG__.app.playing}));
  assert.deepEqual(rollback,{active:'stand',selected:'stand',status:'切换失败',playing:false});
  await faultPage.unroute(pattern);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await faultPage.route(pattern,async route=>{await gate;await route.continue();});
  await faultPage.selectOption('#motion','raise');await faultPage.waitForFunction(()=>window.__R1_DEBUG__.app.busy);
  assert.equal(await faultPage.locator('#play').isDisabled(),true);
  await faultPage.selectOption('#motion','reach');await faultPage.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  assert.equal(await faultPage.evaluate(()=>window.__R1_DEBUG__.app.sim.motionId),'reach');
  const oldResponse=faultPage.waitForResponse(r=>r.url().endsWith(raiseFile));release();await oldResponse;
  await faultPage.waitForFunction(()=>window.__R1_DEBUG__.app.sim.motions.has('raise'));
  assert.deepEqual(await faultPage.evaluate(()=>({active:window.__R1_DEBUG__.app.sim.motionId,selected:document.querySelector('#motion').value})),{active:'reach',selected:'reach'});
  assert.ok((await faultPage.locator('#motion-description').innerText()).includes('双臂前伸'));
  assert.deepEqual(faultErrors,[]);await faultPage.close();
  const policySwitching=await verifyPolicySwitching(page,browser,base);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  fs.writeFileSync('test-results/browser.json',JSON.stringify({status:'passed',url:base,maxAbsoluteActionError:maxError,cases,standing,dynamic,policySwitching,
    loadingHint:{afterResourcesReady:true,desktopAndMobileFits:true,dismissible:true,noAutomaticPlayback:true},
    motionSwitching:{identityChecked:true,physicalArmMotionChecked:true,conditionedMotionPoses,resumeWhilePlaying:true,failedLoadRollback:rollback,latestSelectionWins:true},
    interaction:{push10N:true,dragPeakForce:dragResult.peakForce,releaseClearsForce:true,robotDragWithoutModifier:true,blankDragRotatesCamera:true,
      walkingDrag:{body:walkingHit.body,peakForce:walkingDrag.peakForce,recovery:walkingRecovery}},consoleErrors:errors,failedResponses:requests},null,2));
  console.log('BROWSER_ACCEPTANCE_PASSED');
} catch(error){await page.screenshot({path:'test-results/failure.png',fullPage:true}).catch(()=>{});fs.writeFileSync('test-results/failure.json',JSON.stringify({error:error.stack,pageErrors:errors,failedResponses:requests},null,2));throw error;}finally{await browser.close();}
