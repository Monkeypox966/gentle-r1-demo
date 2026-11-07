import loadMujoco from '@mujoco/mujoco';
import mujocoWasm from '@mujoco/mujoco/mujoco.wasm?url';
import * as ort from 'onnxruntime-web/wasm';
import ortWasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import {CONFIG_FILE} from './bundle.js';
import {Observation,ActionFilter,guardTarget,checkState,normalizeQuat,inverseApply,clamp,cross,norm,referenceSample,assertFinite} from './control.js';

ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.wasm.wasmPaths={wasm:ortWasm};
const BASE=import.meta.env.BASE_URL+'assets/r1/';
const json=async path=>{const r=await fetch(path);if(!r.ok)throw Error(`资源加载失败：${r.status} ${path}`);return r.json();};
export class Simulation {
  constructor(onProgress=()=>{}) {
    this.onProgress=onProgress;this.motionId='stand';this.forceLimit=10;this.spring=false;
    this.drag=null;this.pushUntil=0;this.lastForce=0;this.forceVectors=[];this.steps=0;
    this.policyMs=0;this.motionRequest=0;this.epoch=0;this.fault=null;
  }
  async init() {
    this.onProgress(.05,'正在载入物理引擎');
    this.config=await json(BASE+CONFIG_FILE);
    const c=this.config;
    if(c.observation_dim!==392 || c.action_dim!==24 || c.physical_joint_names.length!==26)throw Error('模型契约不匹配');
    this.mj=await loadMujoco({locateFile:path=>path.endsWith('.wasm')?mujocoWasm:path});
    this.mj.FS.mkdir('/r1');this.mj.FS.mkdir('/r1/meshes');
    const files=Object.keys(c.files).filter(p=>p.startsWith('mujoco/meshes/')||p===c.model_file);
    let done=0;
    // Small batches bound transient download memory; no dataset preload.
    for(let k=0;k<files.length;k+=6) await Promise.all(files.slice(k,k+6).map(async path=>{
      const r=await fetch(BASE+path);if(!r.ok)throw Error(`无法下载 ${path}`);
      const bytes=new Uint8Array(await r.arrayBuffer());
      this.mj.FS.writeFile('/r1/'+path.slice(7),bytes);done++;
      this.onProgress(.12+.55*done/files.length,`正在载入 R1 · ${done}/${files.length}`);
    }));
    this.model=this.mj.MjModel.mj_loadXML('/r1/'+c.model_file.slice(7));
    this.data=new this.mj.MjData(this.model);this.referenceData=new this.mj.MjData(this.model);
    if(this.model.nq!==33 || this.model.nv!==32 || this.model.nu!==26)throw Error('动力学模型不是 R1 26DOF');
    if(Math.abs(this.model.opt.timestep-c.physics_dt)>1e-10||this.model.opt.noslip_iterations!==20)throw Error('接触模型版本不一致，请刷新页面');
    this.physicsSubsteps=Math.round(c.filter_dt/this.model.opt.timestep);
    if(this.physicsSubsteps<1||Math.abs(this.physicsSubsteps*this.model.opt.timestep-c.filter_dt)>1e-10)throw Error('物理步长与滤波频率不整除');
    this.qids=c.physical_joint_names.map(n=>this.model.jnt_qposadr[this.mj.mj_name2id(this.model,this.mj.mjtObj.mjOBJ_JOINT.value,n)]);
    this.vids=c.physical_joint_names.map(n=>this.model.jnt_dofadr[this.mj.mj_name2id(this.model,this.mj.mjtObj.mjOBJ_JOINT.value,n)]);
    this.actToPhysical=Array.from({length:26},(_,i)=>c.physical_joint_names.indexOf(this.mj.mj_id2name(this.model,this.mj.mjtObj.mjOBJ_JOINT.value,this.model.actuator_trnid[2*i])));
    if(this.actToPhysical.some(i=>i<0))throw Error('执行器映射不完整');
    this.wrists=['left_wrist_roll_link','right_wrist_roll_link'].map(n=>this.bodyId(n));this.torso=this.bodyId('waist_yaw_link');this.pelvis=this.bodyId('pelvis_link');
    this.onProgress(.72,'正在载入冻结学生策略');
    const response=await fetch(BASE+'policy.onnx');if(!response.ok)throw Error('ONNX 下载失败');
    const bytes=await response.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==c.onnx_sha256)throw Error('ONNX 完整性检查失败');
    this.session=await ort.InferenceSession.create(bytes,{executionProviders:['wasm'],graphOptimizationLevel:'all'});
    if(this.session.inputNames.join()!=='observation' || this.session.outputNames.join()!=='action')throw Error('策略接口不匹配');
    await this.infer(new Float32Array(392));
    this.motions=new Map();await this.loadMotion('stand');this.reset();this.onProgress(1,'已就绪');
    return this;
  }
  bodyId(name){const id=this.mj.mj_name2id(this.model,this.mj.mjtObj.mjOBJ_BODY.value,name);if(id<0)throw Error(`缺少部件 ${name}`);return id;}
  async loadMotion(id) {
    if(!this.motions.has(id)) {
      const entry=this.config.motions.find(m=>m.id===id);if(!entry)throw Error('未知参考动作');
      const motion=await json(BASE+entry.file);
      if(motion.name!==id||motion.fps!==50||motion.joint_pos.length<2)throw Error('动作格式无效');
      const delta=motion.loop_translation||[0,0,0];assertFinite(delta,3,'循环位移');
      // Exported references have matching position/velocity endpoints. Wrap
      // reference indices only: never reset the physical state at a boundary.
      for(const [key,width] of [['joint_pos',26],['root_pos',3],['root_quat',4],['joint_vel',26],['root_lin_vel',3],['root_ang_vel',3]]){
        if(motion[key]?.length!==motion.joint_pos.length)throw Error('动作帧数不匹配');
        for(const row of motion[key])assertFinite(row,width,key);
        const first=motion[key][0],last=motion[key].at(-1);
        if(first.some((x,i)=>Math.abs(x+(key==='root_pos'?delta[i]:0)-last[i])>1e-8))throw Error('参考动作端点不连续');
      }
      motion.loop=true;
      this.motions.set(id,motion);
    }
    return this.motions.get(id);
  }
  async selectMotion(id) {
    const request=++this.motionRequest;this.epoch++;
    await this.loadMotion(id);
    if(request!==this.motionRequest)return false;
    this.motionId=id;this.reset();return true;
  }
  reset() {
    this.epoch++;const c=this.config,m=this.motions.get(this.motionId);if(!m)return;
    this.mj.mj_resetData(this.model,this.data);
    this.data.qpos.set(m.root_pos[0],0);this.data.qpos[2]+=.04;
    this.data.qpos.set(normalizeQuat(m.root_quat[0]),3);
    for(let i=0;i<26;i++){this.data.qpos[this.qids[i]]=m.joint_pos[0][i];this.data.qvel[this.vids[i]]=m.joint_vel[0][i];}
    this.data.qvel.set(m.root_lin_vel[0],0);this.data.qvel.set(inverseApply(normalizeQuat(m.root_quat[0]),m.root_ang_vel[0]),3);
    this.mj.mj_forward(this.model,this.data);
    this.observer=new Observation(c,this.physicalQ());this.filter=new ActionFilter(c);
    this.lastTwo=[this.physicalQ(),this.physicalQ()];this.frame=this.cycles=this.steps=0;this.fault=null;
    this.lastObservation=new Float32Array(392);this.lastAction=new Float32Array(24);this.lastForce=0;
    this.drag=null;this.pushUntil=0;this.forceVectors=[];
    this.springAnchors=this.wrists.map(b=>Array.from(this.data.xpos.slice(b*3,b*3+3),(x,i)=>x+(i===0?.1:0)));
    this.springStart=1;
    this.updateReference();
  }
  physicalQ(){return Float64Array.from(this.qids,i=>this.data.qpos[i]);}
  physicalV(){return Float64Array.from(this.vids,i=>this.data.qvel[i]);}
  async infer(observation){const out=await this.session.run({observation:new ort.Tensor('float32',observation,[1,392])});return Float32Array.from(out.action.data,x=>clamp(x,-10,10));}
  async step() {
    if(this.fault)throw Error(this.fault);
    const epoch=this.epoch,m=this.motions.get(this.motionId),c=this.config;
    try{
      const q=this.physicalQ(),v=this.physicalV(),quat=Array.from(this.data.qpos.slice(3,7));
      checkState(q,v,quat,c);
      if(this.steps===0)this.lastObservation=new Float32Array(392);
      else {
        this.observer.advance(this.lastTwo);this.frame=(this.frame+1)%(m.joint_pos.length-1);
        if(this.frame===0)this.cycles++;
        this.lastObservation=this.observer.compute(m,this.frame,quat,Array.from(this.data.qvel.slice(3,6)),this.filter.history,this.steps,this.forceLimit);
      }
      const started=performance.now(),action=await this.infer(this.lastObservation);
      this.policyMs=performance.now()-started;
      if(epoch!==this.epoch)return false;
      this.lastAction=action;this.filter.start(action);
      for(let sub=0;sub<4;sub++){
        const guarded=guardTarget(this.filter.target(),this.physicalQ(),this.physicalV(),c);
        for(let a=0;a<26;a++){
          const i=this.actToPhysical[a];this.data.ctrl[a]=guarded.target[i];
          this.model.actuator_gainprm[10*a]=guarded.kp[i];
          this.model.actuator_biasprm[10*a+1]=-guarded.kp[i];
          this.model.actuator_biasprm[10*a+2]=-guarded.kd[i];
        }
        // Existing MJCF position servos compute PD; never write PD torques as ctrl.
        this.mj.mj_forward(this.model,this.data);this.data.qfrc_applied.fill(0);this.data.xfrc_applied.fill(0);
        // Hold the 200Hz joint target during the finer contact integration.
        // Recompute force application at each physics step as bodies move.
        for(let k=0;k<this.physicsSubsteps;k++){
          this.data.qfrc_applied.fill(0);this.data.xfrc_applied.fill(0);this.applyForces();this.mj.mj_step(this.model,this.data);
          if(k+1<this.physicsSubsteps)this.mj.mj_forward(this.model,this.data);
        }
        this.lastTwo=[this.lastTwo[1],this.physicalQ()];
      }
      this.mj.mj_forward(this.model,this.data);this.steps++;this.updateReference();
      return true;
    }catch(error){this.fault=error.message;this.drag=null;throw error;}
  }
  applyForce(body,force,point) {
    this.mj.mj_applyFT(this.model,this.data,force,[0,0,0],point,body,this.data.qfrc_applied);
    this.forceVectors.push({body,point:point.slice(),force:force.slice()});
  }
  applyForces(){
    this.forceVectors=[];let peak=0;
    if(this.spring){
      const ramp=clamp((this.time-this.springStart)/.5,0,1),forces=[],points=[];
      for(let k=0;k<2;k++){
        const b=this.wrists[k],p=Array.from(this.data.xpos.slice(3*b,3*b+3));
        const f=[clamp(150*ramp*(this.springAnchors[k][0]-p[0]),0,30),0,0];
        this.applyForce(b,f,p);peak=Math.max(peak,norm(f));forces.push(f);points.push(p);
      }
      // Same net-wrench cap as the frozen evaluation protocol.
      const total=forces.reduce((s,f)=>s.map((x,i)=>x+f[i]),[0,0,0]);
      const center=Array.from(this.data.xpos.slice(3*this.torso,3*this.torso+3));
      const moment=forces.reduce((s,f,k)=>cross(points[k].map((x,i)=>x-center[i]),f).map((x,i)=>x+s[i]),[0,0,0]);
      const df=total.map(x=>x*(Math.min(1,30/Math.max(norm(total),1e-8))-1));
      const dm=moment.map(x=>x*(Math.min(1,20/Math.max(norm(moment),1e-8))-1));
      this.mj.mj_applyFT(this.model,this.data,df,dm,center,this.torso,this.data.qfrc_applied);
    }
    if(this.drag){
      const {body,local,anchor}=this.drag,mat=this.data.xmat.slice(9*body,9*body+9),pos=this.data.xpos.slice(3*body,3*body+3);
      const point=[0,1,2].map(i=>pos[i]+mat[i*3]*local[0]+mat[i*3+1]*local[1]+mat[i*3+2]*local[2]);
      let force=anchor.map((x,i)=>150*(x-point[i]));const ratio=Math.min(1,30/Math.max(norm(force),1e-8));force=force.map(x=>x*ratio);
      this.applyForce(body,force,point);peak=Math.max(peak,norm(force));
    }
    if(this.time<this.pushUntil){const point=Array.from(this.data.xpos.slice(3*this.torso,3*this.torso+3));this.applyForce(this.torso,[10,0,0],point);peak=Math.max(peak,10);}
    this.lastForce=peak;
  }
  updateReference(){
    const m=this.motions.get(this.motionId),d=this.referenceData;
    const sample=referenceSample(m,this.frame+this.cycles*(m.joint_pos.length-1)),i=sample.index;
    d.qpos.set(sample.pos,0);d.qpos.set(normalizeQuat(sample.quat),3);
    for(let j=0;j<26;j++)d.qpos[this.qids[j]]=m.joint_pos[i][j];
    this.mj.mj_forward(this.model,d);
  }
  get time(){return this.steps*.02;}
  get duration(){return (this.motions.get(this.motionId).joint_pos.length-1)*.02;}
  get root(){return Array.from(this.data.qpos.slice(0,3));}
  setSpring(enabled){
    this.spring=enabled;this.springStart=this.time;
    if(enabled)this.springAnchors=this.wrists.map(b=>Array.from(this.data.xpos.slice(b*3,b*3+3),(x,i)=>x+(i===0?.1:0)));
  }
  push(){this.pushUntil=this.time+.25;}
  dispose(){this.epoch++;this.referenceData?.delete();this.data?.delete();this.model?.delete();this.session?.release();}
}
