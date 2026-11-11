import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function verifyPolicySwitching(page,browser,base){
  await page.setViewportSize({width:1440,height:1050});
  assert.equal(await page.locator('#policy option').count(),2);
  await page.selectOption('#motion','stand');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  await page.selectOption('#policy','vanilla');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  const selected=await page.evaluate(()=>{
    const s=window.__R1_DEBUG__.app.sim;
    return {id:s.policyId,sha:s.policy.checkpoint_sha256,motion:s.motionId,steps:s.steps,force:s.effectiveForceLimit};
  });
  assert.deepEqual(selected,{id:'vanilla',sha:'e63de50193964dd0adb4f8009702f77d2bacfc72a9466106efd5a80c4fab1151',motion:'stand',steps:0,force:10});
  assert.equal(await page.locator('#force-limit').isDisabled(),true);
  assert.ok((await page.locator('#force-note').innerText()).includes('不使用柔顺力调节'));
  const fixtures=JSON.parse(fs.readFileSync('tests/fixtures/policy-vanilla.json'));
  const gentle=JSON.parse(fs.readFileSync('tests/fixtures/policy.json'));
  const parity=await page.evaluate(async ({fixtures,gentle})=>{
    const sim=window.__R1_DEBUG__.app.sim;let error=0,oldDifference=0;
    for(let k=0;k<fixtures.length;k++){
      const a=await sim.infer(Float32Array.from(fixtures[k].observation));
      for(let j=0;j<a.length;j++){
        error=Math.max(error,Math.abs(a[j]-fixtures[k].expected_action[j]));
        oldDifference=Math.max(oldDifference,Math.abs(a[j]-gentle[k].expected_action[j]));
      }
    }
    return {error,oldDifference};
  },{fixtures,gentle});
  assert.ok(parity.error<1e-5,JSON.stringify(parity));assert.ok(parity.oldDifference>.01,'Must really run the independently trained Vanilla network');
  const cases=[];
  for(const id of ['stand','raise','reach','wave','twist','squat','walk']){
    await page.selectOption('#motion',id);await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
    const result=await page.evaluate(async()=>{
      const d=window.__R1_DEBUG__,s=d.app.sim;s.setSpring(false);s.reset();
      const state=await d.runSteps(600);
      return {...state,policy:s.policyId,motion:s.motionId,condition:s.lastObservation[22],physicsTime:s.data.time};
    });
    assert.equal(result.policy,'vanilla');assert.equal(result.motion,id);assert.equal(result.condition,10);
    assert.equal(result.fault,null);assert.ok(result.root[2]>.35);assert.ok(Math.abs(result.physicsTime-12)<1e-7);
    if(id==='walk')assert.ok(result.root[0]>.8,'Vanilla must physically follow the walking reference');
    cases.push(result);console.log('VANILLA_CASE',id,result.root);
  }
  await page.selectOption('#motion','stand');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  const pushed=await page.evaluate(async()=>{
    const d=window.__R1_DEBUG__;await d.runSteps(50);d.app.sim.push();return d.runSteps(100);
  });
  assert.equal(pushed.peakForce,10);assert.equal(pushed.fault,null);
  await page.click('#home-camera');await page.waitForTimeout(100);
  const hit=await page.evaluate(()=>{
    const v=window.__R1_DEBUG__.app.viewer,r=v.renderer.domElement.getBoundingClientRect();
    for(let y=r.top+r.height*.4;y<r.bottom;y+=5)for(let x=r.left+r.width*.4;x<r.left+r.width*.65;x+=5){
      const h=v.pick({clientX:x,clientY:y});if(h?.object.userData.body===v.sim.torso)return {x,y};
    }
    return null;
  });
  assert.ok(hit);await page.mouse.move(hit.x,hit.y);await page.mouse.down();await page.mouse.move(hit.x+8,hit.y,{steps:3});
  const dragged=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(5));assert.ok(dragged.peakForce>0);assert.equal(dragged.fault,null);
  await page.mouse.up();const recovery=await page.evaluate(()=>window.__R1_DEBUG__.runSteps(50));assert.equal(recovery.fault,null);assert.equal(recovery.force,0);
  await page.click('#reset');await page.screenshot({path:'test-results/policy-vanilla.png',fullPage:true});
  await page.click('#play');await page.selectOption('#policy','gentle');await page.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.playing),true);
  await page.click('#play');assert.equal(await page.locator('#force-limit').isDisabled(),false);
  assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.policyId),'gentle');
  const oldParity=await page.evaluate(async cases=>{
    let max=0;for(const c of cases){const a=await window.__R1_DEBUG__.app.sim.infer(Float32Array.from(c.observation));for(let i=0;i<24;i++)max=Math.max(max,Math.abs(a[i]-c.expected_action[i]));}return max;
  },gentle);
  assert.ok(oldParity<1e-5);assert.equal(await page.evaluate(()=>window.__R1_DEBUG__.app.sim.policySessions.size),2);
  await page.click('#reset');await page.screenshot({path:'test-results/policy-gentle.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'test-results/policy-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1050});
  // Fresh page: failed and out-of-order lazy model downloads cannot change
  // the active policy, even when a motion selection intervenes.
  const faultPage=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
  faultPage.on('pageerror',error=>errors.push(error.message));
  await faultPage.goto(base,{waitUntil:'networkidle',timeout:120000});
  await faultPage.waitForFunction(()=>window.__R1_DEBUG__?.app.loaded,null,{timeout:120000});
  await faultPage.keyboard.press('Escape');await faultPage.locator('#interaction-help').waitFor({state:'hidden'});
  const file=await faultPage.evaluate(()=>window.__R1_DEBUG__.app.sim.config.policies.find(p=>p.id==='vanilla').file),pattern='**/'+file;
  await faultPage.route(pattern,route=>route.abort('failed'));
  await faultPage.selectOption('#policy','vanilla');await faultPage.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  const rollback=await faultPage.evaluate(()=>({active:window.__R1_DEBUG__.app.sim.policyId,selected:document.querySelector('#policy').value,playing:window.__R1_DEBUG__.app.playing}));
  assert.deepEqual(rollback,{active:'gentle',selected:'gentle',playing:false});
  await faultPage.unroute(pattern);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await faultPage.route(pattern,async route=>{await gate;await route.continue();});
  await faultPage.selectOption('#policy','vanilla');await faultPage.waitForFunction(()=>window.__R1_DEBUG__.app.busy);
  assert.equal(await faultPage.locator('#play').isDisabled(),true);
  await faultPage.selectOption('#policy','gentle');await faultPage.selectOption('#motion','reach');
  await faultPage.waitForFunction(()=>!window.__R1_DEBUG__.app.busy);
  release();await faultPage.waitForFunction(()=>window.__R1_DEBUG__.app.sim.policySessions.has('vanilla'));
  assert.deepEqual(await faultPage.evaluate(()=>({policy:window.__R1_DEBUG__.app.sim.policyId,motion:window.__R1_DEBUG__.app.sim.motionId,selected:document.querySelector('#policy').value})),{policy:'gentle',motion:'reach',selected:'gentle'});
  assert.deepEqual(errors,[]);await faultPage.close();
  return {vanillaParity:parity,gentleReturnParity:oldParity,cases,push:pushed,drag:dragged,recovery,
    failedLoadRollback:rollback,sharedMotionPolicyLatestRequestWins:true,sessionCacheBounded:2};
}
