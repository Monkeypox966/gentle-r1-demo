import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Observation,ActionFilter,guardTarget} from '../src/control.js';
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
