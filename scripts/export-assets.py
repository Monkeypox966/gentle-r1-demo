"""Export the frozen R1 bundle and original synthetic reference motions.

No training datasets are redistributed; no training configuration is modified.
"""
from pathlib import Path
import json
import hashlib
import shutil
import sys
import xml.etree.ElementTree as ET
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path('/home/mapinxuan/gentle-r1/results/deployment/student').resolve()
sys.path.insert(0,'/home/mapinxuan/gentle-r1/deployment')
from gentle_r1_deploy.schema import sha256
from gentle_r1_deploy.motion import Motion
from gentle_r1_deploy.observation import Observation,ActionFilter


def main():
    mf=json.loads((SOURCE/'manifest.json').read_text())
    assert mf['checkpoint_sha256']=='61a5b331557f8e031de4f05fd71b48f58892e8d020578eaaeb1ea45f104af9c5'
    out=ROOT/'public/assets/r1';out.mkdir(parents=True,exist_ok=True)
    for pattern in ['config-*.json','mujoco/r1-contact-*.xml']:
        for old in out.glob(pattern): old.unlink()
    shutil.copy2(SOURCE/'policy.onnx',out/'policy.onnx')
    shutil.copytree(SOURCE/'mujoco',out/'mujoco',dirs_exist_ok=True)
    source_model_sha=sha256(SOURCE/'mujoco/r1.xml')
    model=ET.parse(out/'mujoco/r1.xml')
    contact_settings={'timestep':'0.001','cone':'elliptic','impratio':'10','noslip_iterations':'20'}
    model.getroot().find('option').attrib.update(contact_settings)
    model.write(out/'mujoco/r1.xml',encoding='unicode')
    model_file=f'mujoco/r1-contact-{sha256(out/"mujoco/r1.xml")[:12]}.xml'
    shutil.copy2(out/'mujoco/r1.xml',out/model_file)
    config={k:mf[k] for k in ['schema_version','robot','checkpoint_sha256','observation_dim','action_dim',
        'physical_joint_names','observation_joint_names','reference_joint_names','action_joint_names',
        'control_dt','filter_dt','kp','kd','effort','velocity','lower','upper','default','default_root_height','action_scale']}
    config['onnx_sha256']=sha256(out/'policy.onnx')
    config['physics_dt']=.001
    config['browser_contact_solver']=contact_settings
    config['model_file']=model_file
    config['motions']=[]
    count=501;t=np.arange(count)*.02
    # Smooth endpoints: no loop discontinuity, at most moderate arm excursions.
    phase=np.clip((t-1.)/2.,0,1);ramp=phase*phase*(3-2*phase)
    down=np.clip((10-t)/2.,0,1);ramp*=down*down*(3-2*down)
    motions={}
    for name,label,description in [
        ('stand','自然站立','固定的 R1 默认参考，观察策略如何维持平衡。'),
        ('raise','双臂抬起','自主生成的平滑抬臂参考，不是录制动画。'),
        ('reach','双臂前伸','自主生成的前伸参考，适合比较腕部弹簧扰动。')]:
        q=np.tile(config['default'],(count,1)).astype(float)
        names=config['physical_joint_names']
        if name in {'raise','reach'}:
            for side in ['left','right']:
                q[:,names.index(side+'_shoulder_pitch_joint')]-=(.75 if name=='raise' else .9)*ramp
                q[:,names.index(side+'_elbow_joint')]+=(.2 if name=='raise' else -.25)*ramp
                q[:,names.index(side+'_shoulder_roll_joint')]+= (1 if side=='left' else -1)*(.12 if name=='raise' else .03)*ramp
        pos=np.tile([0.,0.,config['default_root_height']],(count,1))
        quat=np.tile([1.,0.,0.,0.],(count,1))
        motion=Motion(q,pos,quat,np.gradient(q,.02,axis=0),np.zeros_like(pos),np.zeros_like(pos))
        payload={'name':name,'fps':50,'joint_pos':motion.q.tolist(),'root_pos':pos.tolist(),'root_quat':quat.tolist(),
                 'joint_vel':motion.joint_vel.tolist(),'root_lin_vel':motion.root_lin_vel.tolist(),'root_ang_vel':motion.root_ang_vel.tolist(),
                 'source':'original analytic reference generated for this demo','license':'BSD-3-Clause'}
        (out/f'{name}.json').write_text(json.dumps(payload,separators=(',',':'))+'\n')
        config['motions'].append({'id':name,'label':label,'description':description,'file':f'{name}.json','duration':10.})
        motions[name]=motion
    config['files']={str(p.relative_to(out)):sha256(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name!='config.json'}
    (out/'config.json').write_text(json.dumps(config,indent=2,ensure_ascii=False)+'\n')
    config_file=f'config-{sha256(out/"config.json")[:12]}.json'
    shutil.copy2(out/'config.json',out/config_file)
    (ROOT/'src/bundle.js').write_text('// Generated asset-version boundary; avoids mixing cached contact models.\n'
        +f'export const CONFIG_FILE = "{config_file}";\n')
    # Independent Python oracle for JS observation, filter and policy tests.
    rng=np.random.default_rng(731);oracle=[]
    for j in range(8):
        q=np.array(config['default'])+rng.normal(0,.03,26)
        observer=Observation(q);samples=rng.normal(0,.1,(2,26))+q
        observer.advance(samples)
        action=rng.normal(0,.3,(3,24))
        quat=rng.normal(size=4);quat/=np.linalg.norm(quat)
        gyro=rng.normal(0,.1,3);frame=j*19;step=j*4;force=5+j
        obs=observer.compute(motions['raise'],frame,quat,gyro,action,step,force)
        oracle.append({'q':q.tolist(),'samples':samples.tolist(),'quat':quat.tolist(),'gyro':gyro.tolist(),
                       'actions':action.tolist(),'frame':frame,'step':step,'force':force,'observation':obs.tolist()})
    fixture=ROOT/'tests/fixtures';fixture.mkdir(parents=True,exist_ok=True)
    (fixture/'observations.json').write_text(json.dumps(oracle,separators=(',',':')))
    # Normalization parity needs raw, deterministic network outputs.
    from gentle_r1_deploy.policy import Student
    student=Student(SOURCE)
    for case in oracle:case['expected_action']=student.action(case['observation']).tolist()
    (fixture/'policy.json').write_text(json.dumps(oracle,separators=(',',':')))
    filter_config={k:np.array(v) if isinstance(v,list) else v for k,v in config.items()}
    port=ActionFilter(filter_config);filter_cases=[]
    for _ in range(6):
        raw=rng.normal(0,8,24);port.start(raw)
        filter_cases.append({'raw':raw.tolist(),'targets':[port.target().tolist() for _ in range(4)],'history':port.history.tolist()})
    (fixture/'actions.json').write_text(json.dumps(filter_cases,separators=(',',':')))
    (ROOT/'ASSET_PROVENANCE.json').write_text(json.dumps({'checkpoint_sha256':config['checkpoint_sha256'],
        'onnx_sha256':config['onnx_sha256'],'mujoco_version':'3.12.0','motion_source':'original synthetic references',
        'source_training_project':'gentle-r1','raw_training_data_included':False,'assets':config['files'],
        'browser_model_changes':{'source_model_sha256':source_model_sha,'option':contact_settings,
          'friction_unchanged':1.0,'reason':'Contact-accuracy audit; policy 50Hz and target filter 200Hz unchanged; no foot pinning.'}},indent=2)+'\n')
    print('Exported frozen R1 model and three original reference motions')


if __name__=='__main__':main()
