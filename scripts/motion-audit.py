"""Bounded, headless CPU screening of the frozen policy on authored references."""
from pathlib import Path
from types import SimpleNamespace
import argparse
import importlib.util
import json
import sys
import numpy as np
import mujoco as mj

sys.path.insert(0,'/home/mapinxuan/gentle-r1/deployment')
from gentle_r1_deploy.motion import Motion
from gentle_r1_deploy.observation import Observation,ActionFilter
from gentle_r1_deploy.policy import Student
from gentle_r1_deploy.controller import guard_target

ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'public/assets/r1'

def run(raw,config,student,seconds,force=10,push=False):
    model=mj.MjModel.from_xml_path(str(ASSETS/'mujoco/r1.xml'))
    data=mj.MjData(model)
    names=config['physical_joint_names']
    qids=[model.joint(n).qposadr[0] for n in names]
    vids=[model.joint(n).dofadr[0] for n in names]
    order=[names.index(model.joint(int(j[0])).name) for j in model.actuator_trnid]
    feet=[model.body(s+'_ankle_roll_link').id for s in ['left','right']]
    torso=model.body('waist_yaw_link').id
    # Extend world translation through the seam, matching browser lookahead.
    q=np.asarray(raw['joint_pos']);pos=np.asarray(raw['root_pos']);quat=np.asarray(raw['root_quat'])
    period=len(q)-1;frames=round(seconds*50)
    ids=np.arange(frames+20)%period;cycles=np.arange(frames+20)//period
    delta=np.asarray(raw.get('loop_translation',[0,0,0]))
    motion=Motion(q[ids],pos[ids]+cycles[:,None]*delta,quat[ids])
    data.qpos[:3]=pos[0]+[0,0,.04];data.qpos[3:7]=quat[0];data.qpos[qids]=q[0]
    data.qvel[:3]=raw['root_lin_vel'][0];data.qvel[vids]=raw['joint_vel'][0]
    mj.mj_forward(model,data)
    observer=Observation(data.qpos[qids]);filt=ActionFilter(student.manifest)
    samples=[data.qpos[qids].copy(),data.qpos[qids].copy()]
    trace=[];fault=None;errors=[]
    for step in range(frames):
        tilt=np.arccos(np.clip(-RotationInv(data.qpos[3:7])[2],-1,1))
        if (not np.isfinite(data.qpos).all() or tilt>.9
            or np.any(np.abs(data.qvel[vids])>np.asarray(config['velocity'])*1.5)
            or np.any(data.qpos[qids]<np.asarray(config['lower'])-.15)
            or np.any(data.qpos[qids]>np.asarray(config['upper'])+.15)):
            fault=f'state guard at {step*.02:.2f}s, tilt={tilt:.3f}';break
        if step:
            observer.advance(samples)
            obs=observer.compute(motion,step,data.qpos[3:7],data.qvel[3:6],filt.history,step,force)
        else:obs=np.zeros(392,np.float32)
        filt.start(student.action(obs))
        for _ in range(4):
            state=SimpleNamespace(q=data.qpos[qids],dq=data.qvel[vids])
            target,kp,kd,_=guard_target(filt.target(),state,student.manifest,{'joint_margin_radians':.02})
            data.ctrl[:]=target[order];model.actuator_gainprm[:,0]=kp[order]
            model.actuator_biasprm[:,1]=-kp[order];model.actuator_biasprm[:,2]=-kd[order]
            for _ in range(5):
                data.qfrc_applied[:]=0
                mj.mj_forward(model,data)
                if push and 4<=step*.02<4.25:
                    mj.mj_applyFT(model,data,[0,10,0],[0,0,0],data.xpos[torso],torso,data.qfrc_applied)
                mj.mj_step(model,data)
            samples=[samples[1],data.qpos[qids].copy()]
        mj.mj_forward(model,data)
        errors.append(np.sqrt(np.mean((data.qpos[qids][:24]-motion.q[step][:24])**2)))
        if step%5==0:
            trace.append({'t':(step+1)*.02,'root':data.qpos[:3].tolist(),'feet':data.xpos[feet].tolist(),
                'q':data.qpos[qids].tolist(),'reference':motion.q[step].tolist(),'tilt':float(tilt)})
    settled=[f for f in trace if f['t']>=2]
    positions=np.array([f['root'] for f in settled])
    foot_z=np.array([f['feet'] for f in settled])[:,:,2]
    return {'id':raw['name'],'force':force,'push':push,'seconds':seconds,'completed':(step+1)*.02,'fault':fault,
        'joint_rmse_rad':float(np.sqrt(np.mean(np.square(errors)))) if errors else None,'final_root':data.qpos[:3].tolist(),
        'root_height_range':np.ptp(positions[:,2]).item() if len(positions) else None,
        'root_xy_travel':np.linalg.norm(np.diff(positions[:,:2],axis=0),axis=1).sum().item() if len(positions) else None,
        'foot_height_range':np.ptp(foot_z,axis=0).tolist() if len(foot_z) else None,'trace':trace}

def RotationInv(q):
    from gentle_r1_deploy.observation import inverse_apply
    return inverse_apply(q,np.array([0.,0.,-1.]))

def main():
    p=argparse.ArgumentParser();p.add_argument('--seconds',type=float,default=22)
    p.add_argument('--motions',nargs='+',default=['wave','twist','squat','walk'])
    p.add_argument('--gait',nargs=4,type=float,metavar=('SPEED','CLEARANCE','SWAY','PERIOD'))
    p.add_argument('--forces',nargs='+',type=float,default=[10]);p.add_argument('--push',action='store_true')
    p.add_argument('--output',default='test-results/motion-audit.json');args=p.parse_args()
    if args.seconds<2 or any(not 5<=force<=15 for force in args.forces):
        p.error('Use at least two seconds and force conditions within 5..15N')
    config=json.loads((ASSETS/'config.json').read_text())
    student=Student('/home/mapinxuan/gentle-r1/results/deployment/student')
    if args.gait:
        spec=importlib.util.spec_from_file_location('dynamic_references',ROOT/'scripts/dynamic_references.py')
        generator=importlib.util.module_from_spec(spec);spec.loader.exec_module(generator)
        speed,clearance,sway,period=args.gait
        motions=generator.generate(config,ASSETS/'mujoco/r1.xml',speed=speed,clearance=clearance,sway=sway,period=period)
    else:motions={name:json.loads((ASSETS/(name+'.json')).read_text()) for name in args.motions}
    results=[]
    for force in args.forces:
        for name in args.motions:
            result=run(motions[name],config,student,args.seconds,force,args.push)
            results.append(result);print(json.dumps({k:v for k,v in result.items() if k!='trace'}),flush=True)
    out=ROOT/args.output;out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps({'gait':args.gait,'results':results},indent=2)+'\n')
    if any(result['fault'] for result in results):
        raise RuntimeError('Motion screening failed; inspect the saved evidence')

if __name__=='__main__':main()
