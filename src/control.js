// R1 policy boundary. Reference, action and measured-history orders are distinct.
// Numerical contract independently checked against the frozen Python runtime.
export const FUTURE = [0, 2, 4, 8, 16];
export const HISTORY = [0, 1, 2, 3, 4, 8];
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const zeros = (n) => new Float64Array(n);
export const norm = (x) => Math.hypot(...x);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const normalizeQuat = (q) => { const n = norm(q); if (!(n > .1)) throw Error('无效四元数'); return Array.from(q, x => x/n); };
export const yaw = ([w,x,y,z]) => Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z));
export function inverseApply(q, v) {
  const xyz = [q[1],q[2],q[3]], t = cross(xyz,v).map(x=>2*x), c=cross(xyz,t);
  return v.map((x,i)=>x-q[0]*t[i]+c[i]);
}
export function inverseYaw(a, v) { return [Math.cos(a)*v[0]+Math.sin(a)*v[1],-Math.sin(a)*v[0]+Math.cos(a)*v[1]]; }
export function assertFinite(a, length, label) {
  if (a.length !== length || !Array.from(a).every(Number.isFinite)) throw Error(`${label} 维度或数值异常`);
}
export class Observation {
  constructor(config, physicalQ) {
    this.config=config;
    this.ids=config.observation_joint_names.map(n=>config.physical_joint_names.indexOf(n));
    if (this.ids.some(i=>i<0)) throw Error('关节映射不完整');
    this.history=Array.from({length:9},()=>Float64Array.from(this.ids,i=>physicalQ[i]));
  }
  advance(samples) {
    this.history.pop();
    this.history.unshift(Float64Array.from(this.ids,i=>(samples[0][i]+samples[1][i])/2));
  }
  compute(motion, frame, quat, gyro, actions, step, force) {
    if (!Number.isFinite(force) || force<5 || force>15) throw Error('力条件超出训练范围');
    const ids=FUTURE.map(k=>motion.loop?(frame+k)%(motion.joint_pos.length-1):Math.min(frame+k,motion.joint_pos.length-1));
    const pos=ids.map(i=>motion.root_pos[i]), qs=ids.map(i=>motion.root_quat[i]);
    const angle=yaw(qs[0]), packed=[Math.max(25-step,0)/25,...pos.map(p=>p[2])];
    for(let i=1;i<5;i++) packed.push(...inverseYaw(angle,pos[i].map((x,j)=>x-pos[0][j])));
    for(let i=1;i<5;i++) {const a=yaw(qs[i])-angle;packed.push(Math.cos(a),Math.sin(a));}
    packed.push(force);
    // Targets remain in dataset URDF order, not action BFS order.
    for (const i of ids) packed.push(...motion.joint_pos[i].slice(0,24));
    for (const q of qs) packed.push(...inverseApply(q,[0,0,-1]));
    packed.push(...gyro,...inverseApply(normalizeQuat(quat),[0,0,-1]));
    for (const i of HISTORY) packed.push(...this.history[i]);
    for (const a of actions) packed.push(...a);
    assertFinite(packed,392,'观测');
    return Float32Array.from(packed);
  }
}
export class ActionFilter {
  constructor(config) {
    this.config=config;
    this.ids=config.action_joint_names.map(n=>config.physical_joint_names.indexOf(n));
    this.applied=zeros(24);this.history=Array.from({length:3},()=>zeros(24));
  }
  start(action) {
    assertFinite(action,24,'策略动作');
    this.history.pop();this.history.unshift(Float64Array.from(action,x=>clamp(x,-10,10)));
  }
  target() {
    const target=Float64Array.from(this.config.default);
    for (let i=0;i<24;i++) {
      this.applied[i]+=.9*(this.history[0][i]-this.applied[i]);
      target[this.ids[i]]+=this.applied[i]*this.config.action_scale[i];
    }
    target[24]=target[25]=0;
    return target;
  }
}
export function guardTarget(raw,q,dq,c) {
  const target=zeros(26),kp=Float64Array.from(c.kp),kd=Float64Array.from(c.kd);
  for (let i=0;i<26;i++) {
    const desired=clamp(raw[i],c.lower[i]+.02,c.upper[i]-.02);
    const effort=clamp(kp[i]*(desired-q[i])-kd[i]*dq[i],-c.effort[i],c.effort[i]);
    target[i]=clamp(q[i]+(effort+kd[i]*dq[i])/kp[i],c.lower[i]+.02,c.upper[i]-.02);
  }
  for (const i of [24,25]) {
    target[i]=0;
    const t=-kp[i]*q[i]-kd[i]*dq[i], f=Math.min(1,c.effort[i]/Math.max(Math.abs(t),1e-12));
    kp[i]*=f;kd[i]*=f;
  }
  assertFinite(target,26,'关节目标');
  if (target.some((x,i)=>Math.abs(kp[i]*(x-q[i])-kd[i]*dq[i])>c.effort[i]+1e-7)) throw Error('关节目标与预测力矩保护冲突');
  return {target,kp,kd};
}
export function checkState(q,dq,quat,c) {
  assertFinite(q,26,'关节状态');assertFinite(dq,26,'关节速度');
  if (q.some((x,i)=>x<c.lower[i]-.15 || x>c.upper[i]+.15)) throw Error('关节位置超差，已暂停');
  if (dq.some((x,i)=>Math.abs(x)>c.velocity[i]*1.5)) throw Error('关节速度超差，已暂停');
  const g=inverseApply(normalizeQuat(quat),[0,0,-1]);
  if (Math.acos(clamp(-g[2],-1,1))>.9) throw Error('机身倾斜超差，已暂停');
}
