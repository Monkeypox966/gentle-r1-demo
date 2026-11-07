"""Original, reproducible R1 reference trajectories; no motion dataset input.

The gait solves both six-axis legs against authored foot paths. This only
produces reference targets: the frozen policy must drive the physical robot.
"""
import numpy as np
import mujoco as mj
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation


def generate(config, model_path, *, speed=.18, clearance=.055, sway=.055, period=1.25):
    if abs(10/period-round(10/period))>1e-8:
        raise ValueError('The gait period must divide the ten-second reference loop')
    count=501
    t=np.arange(count)*.02
    default=np.asarray(config['default'])
    names=config['physical_joint_names']
    q=np.tile(default,(count,1))
    pos=np.tile([0.,0.,config['default_root_height']],(count,1))
    quat=np.tile([1.,0.,0.,0.],(count,1))
    result={}
    # Smooth repeated movements with zero endpoint velocities.
    pulse=np.sin(np.pi*t/5)**2
    wave=q.copy()
    for side,sign in [('left',1),('right',-1)]:
        wave[:,names.index(side+'_shoulder_pitch_joint')]-=.55*pulse
        wave[:,names.index(side+'_shoulder_roll_joint')]+=sign*.38*pulse
        wave[:,names.index(side+'_elbow_joint')]+=.45*pulse
        wave[:,names.index(side+'_wrist_roll_joint')]+=sign*.45*pulse*np.sin(2*np.pi*t)
    result['wave']=('双臂挥动','周期性抬臂与摆腕，运动中可拖动机器人施力。',wave,pos.copy(),quat.copy())
    twist=q.copy()
    twist[:,names.index('waist_yaw_joint')]=.3*np.sin(2*np.pi*t/5)**3
    for side in ['left','right']:
        twist[:,names.index(side+'_shoulder_pitch_joint')]-=.4*pulse
    result['twist']=('转腰摆臂','双臂配合周期性转腰，同一个冻结策略实时跟踪。',twist,pos.copy(),quat.copy())
    model=mj.MjModel.from_xml_path(str(model_path))
    data=mj.MjData(model)
    qids=[int(model.joint(n).qposadr[0]) for n in names]
    data.qpos[:3]=pos[0];data.qpos[3:7]=quat[0];data.qpos[qids]=default
    mj.mj_forward(model,data)
    feet=[model.body(s+'_ankle_roll_link').id for s in ['left','right']]
    foot_pos=data.xpos[feet].copy()
    foot_rot=data.xmat[feet].reshape(2,3,3).copy()
    lower=np.asarray(config['lower'])+.025;upper=np.asarray(config['upper'])-.025

    def solve_leg(root, targets, previous):
        data.qpos[:3]=root;data.qpos[3:7]=[1,0,0,0]
        answer=previous.copy()
        for leg,body in enumerate(feet):
            indices=np.arange(leg*6,leg*6+6)
            def error(values):
                data.qpos[np.asarray(qids)[indices]]=values
                mj.mj_fwdPosition(model,data)
                angle=Rotation.from_matrix(foot_rot[leg].T@data.xmat[body].reshape(3,3)).as_rotvec()
                return np.r_[data.xpos[body]-targets[leg],.2*angle]
            fit=least_squares(error,previous[indices],bounds=(lower[indices],upper[indices]),
                              ftol=1e-9,xtol=1e-9,gtol=1e-9,max_nfev=40)
            if np.linalg.norm(error(fit.x))>1e-5:
                raise ValueError('Authored foot path is unreachable')
            answer[indices]=fit.x
        return answer

    squat=q.copy();squat_pos=pos.copy();squat_pos[:,2]-=.065*pulse
    previous=default.copy()
    for i in range(count):
        previous=solve_leg(squat_pos[i],foot_pos,previous)
        squat[i]=previous
        for side in ['left','right']:
            squat[i,names.index(side+'_shoulder_pitch_joint')]-=.35*pulse[i]
    result['squat']=('连续浅蹲','双脚支撑，周期性下蹲与起身，可在运动中推拉机器人。',squat,squat_pos,quat.copy())

    walk=q.copy();walk_pos=pos.copy()
    walk_pos[:,0]=speed*t
    swing=.4
    previous=default.copy()
    for i,time in enumerate(t):
        phase=(time/period+.45)%1
        walk_pos[i,1]=-sway*np.cos(2*np.pi*(phase-swing/2))
        walk_pos[i,2]-=.01
        targets=foot_pos.copy()
        for leg in range(2):
            u=(phase+.5*leg)%1
            a=.5*speed*(1-swing)*period
            if u<swing:
                p=u/swing
                x=-a+2*a*(3*p*p-2*p**3)-speed*swing*period*(2*p**3-3*p*p+p)
                z=clearance*np.sin(np.pi*p)**2
            else:
                x=a-speed*period*(u-swing)
                z=0.
            targets[leg,0]+=walk_pos[i,0]+x
            targets[leg,2]+=z
        previous=solve_leg(walk_pos[i],targets,previous)
        walk[i]=previous
        for side,sign in [('left',1),('right',-1)]:
            walk[i,names.index(side+'_shoulder_pitch_joint')]+=.15*sign*np.sin(2*np.pi*phase)
    # Equal cyclic poses/velocities; root translation is carried across loops.
    walk[-1]=walk[0];walk_pos[-1]=walk_pos[0]+[speed*10,0,0]
    result['walk']=('向前步行','自主生成的低速步行参考；真实策略驱动迈步与前进，可在行走中施力。',walk,walk_pos,quat.copy())
    output={}
    for name,(label,description,joints,root,rotation) in result.items():
        if np.max(np.abs(joints[-1]-joints[0]))>1e-5:
            raise ValueError('Reference joint endpoints do not match')
        joints[-1]=joints[0]  # Remove iterative IK termination roundoff.
        delta=root[-1]-root[0]
        def derivative(array,offset):
            core=array[:-1]
            before=np.roll(core,1,axis=0);before[0]-=offset
            after=np.roll(core,-1,axis=0);after[-1]+=offset
            velocity=(after-before)/.04
            return np.concatenate([velocity,velocity[:1]])
        output[name]={'name':name,'fps':50,'joint_pos':joints.tolist(),'root_pos':root.tolist(),
            'root_quat':rotation.tolist(),'joint_vel':derivative(joints,np.zeros(26)).tolist(),
            'root_lin_vel':derivative(root,delta).tolist(),'root_ang_vel':np.zeros((count,3)).tolist(),
            'loop_translation':delta.tolist(),'source':'original procedural reference; R1 leg IK for squat/walk',
            'license':'BSD-3-Clause','label':label,'description':description}
    return output
