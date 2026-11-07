import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Observation,ActionFilter,guardTarget,referenceSample} from '../src/control.js';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url)));
const config=read('../public/assets/r1/config.json'),motion=read('../public/assets/r1/raise.json');
function close(actual,expected,tolerance=2e-6){assert.equal(actual.length,expected.length);const diff=Math.max(...Array.from(actual,(x,i)=>Math.abs(x-expected[i])));assert.ok(diff<=tolerance,`max numerical error ${diff}`);}
test('392-value browser observation matches eight independent Python oracle cases',()=>{
  for(const c of read('./fixtures/observations.json')){
    const obs=new Observation(config,c.q);obs.advance(c.samples);
    close(obs.compute(motion,c.frame,c.quat,c.gyro,c.actions,c.step,c.force),c.observation);
  }
});
test('200Hz filter, action ordering and three-step raw history match Python',()=>{
  const filter=new ActionFilter(config);
  for(const c of read('./fixtures/actions.json')){
    filter.start(c.raw);for(const t of c.targets)close(filter.target(),t,1e-11);
    filter.history.forEach((a,i)=>close(a,c.history[i],1e-11));
  }
});
test('head zero and predicted-effort guard survive extreme raw targets',()=>{
  const q=Float64Array.from(config.default),dq=new Float64Array(26);q[25]=.2;
  const result=guardTarget(config.default.map(x=>x+2),q,dq,config);
  assert.equal(result.target[24],0);assert.equal(result.target[25],0);
  for(let i=0;i<26;i++)assert.ok(Math.abs(result.kp[i]*(result.target[i]-q[i])-result.kd[i]*dq[i])<=config.effort[i]+1e-8);
});
test('frozen shapes and reference/action orders are deliberately distinct',()=>{
  assert.equal(config.observation_dim,392);assert.equal(config.action_dim,24);
  assert.equal(config.physical_joint_names.length,26);
  assert.notDeepEqual(config.reference_joint_names,config.action_joint_names);
  assert.equal(config.control_dt,.02);assert.equal(config.filter_dt,.005);
});
test('invalid non-finite policy input is rejected before inference',()=>{
  const obs=new Observation(config,config.default);
  assert.throws(()=>obs.compute(motion,0,[1,0,0,0],[0,0,0],Array.from({length:3},()=>new Float64Array(24)),0,NaN));
});
test('loop lookahead wraps across the seam instead of clamping or restarting history',()=>{
  const period=5,ref={loop:true,joint_pos:[],root_pos:[],root_quat:[]};
  for(let i=0;i<=period;i++){
    const q=config.default.slice();q[0]=Math.sin(2*Math.PI*i/period);
    ref.joint_pos.push(q);ref.root_pos.push([0,0,.73]);ref.root_quat.push([1,0,0,0]);
  }
  const observer=new Observation(config,config.default);
  observer.advance([config.default.map(x=>x+.01),config.default.map(x=>x+.01)]);
  const obs=observer.compute(ref,4,[1,0,0,0],[0,0,0],Array.from({length:3},()=>new Float64Array(24)),99,10);
  for(const [i,frame] of [4,1,3,2,0].entries())assert.ok(Math.abs(obs[23+i*24]-ref.joint_pos[frame][0])<1e-7);
  assert.equal(obs[0],0);
  assert.ok(Math.abs(observer.history[0][0]-observer.history[1][0]-.01)<1e-12);
});
test('walking future samples carry root displacement across every seam',()=>{
  const ref=read('../public/assets/r1/walk.json');ref.loop=true;
  const period=ref.joint_pos.length-1,delta=ref.loop_translation;
  for(const cycle of [0,1,20]){
    const sample=referenceSample(ref,(cycle+1)*period);
    close(sample.pos,ref.root_pos[0].map((x,i)=>x+(cycle+1)*delta[i]),1e-12);
    const before=referenceSample(ref,(cycle+1)*period-1),after=referenceSample(ref,(cycle+1)*period+1);
    assert.ok(Math.abs(after.pos[0]-before.pos[0]-.18*.04)<1e-10);
  }
  const obs=new Observation(config,config.default).compute(ref,499,[1,0,0,0],[0,0,0],Array.from({length:3},()=>new Float64Array(24)),999,10);
  // Root XY lookahead starts at packed index 6, with horizons 2,4,8,16.
  for(const [k,horizon] of [2,4,8,16].entries())assert.ok(Math.abs(obs[6+k*2]-.18*.02*horizon)<1e-7);
  assert.ok(Math.max(...obs.slice(6,14).map(Math.abs))<.1,'No 1.8m backward jump at a gait seam');
});
