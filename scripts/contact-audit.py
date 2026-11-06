"""Reproduce standing contact drift with the frozen controller, without rendering.

Runs one simulation at a time. No training input or checkpoint is modified.
Use the local resource wrapper and the deployment uv environment on this host.
"""
from pathlib import Path
from types import SimpleNamespace
import argparse
import json
import sys
import time
import hashlib
import numpy as np
import mujoco as mj

sys.path.insert(0, '/home/mapinxuan/gentle-r1/deployment')
from gentle_r1_deploy.observation import Observation, ActionFilter
from gentle_r1_deploy.motion import Motion
from gentle_r1_deploy.policy import Student
from gentle_r1_deploy.controller import guard_target

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public/assets/r1'
SOURCE_MODEL = Path('/home/mapinxuan/gentle-r1/results/deployment/student/mujoco/r1.xml')


def run(student, config, motion, variant, seconds):
    model = mj.MjModel.from_xml_path(str(SOURCE_MODEL))
    if variant == 'mu3':
        model.geom_friction[:, 0] = 3
    if variant.startswith('elliptic'):
        model.opt.cone = mj.mjtCone.mjCONE_ELLIPTIC
        model.opt.impratio = float(variant.split('-')[0][8:])
    if 'noslip' in variant:
        model.opt.noslip_iterations = int(variant.split('noslip')[1].split('-')[0])
    if 'hard' in variant:
        model.geom_solimp[:, :2] = .999
    if 'condim6' in variant:
        model.geom_condim[:] = 6
    if 'dt2500' in variant:
        model.opt.timestep = .0025
    if 'dt1000' in variant:
        model.opt.timestep = .001
    data = mj.MjData(model)
    names = config['physical_joint_names']
    qids = [model.joint(n).qposadr[0] for n in names]
    vids = [model.joint(n).dofadr[0] for n in names]
    order = [names.index(model.joint(int(j[0])).name) for j in model.actuator_trnid]
    feet = [model.body(side + '_ankle_roll_link').id for side in ['left', 'right']]
    ground = model.geom('ground').id
    mf = student.manifest
    data.qpos[:3] = motion.pos[0] + [0, 0, .04]
    data.qpos[3:7] = motion.quat[0]
    data.qpos[qids] = motion.q[0]
    mj.mj_forward(model, data)
    observer = Observation(data.qpos[qids])
    filt = ActionFilter(mf)
    samples = [data.qpos[qids].copy(), data.qpos[qids].copy()]
    velocities, utilization, normals, trace = [], [], [], []
    saturated = 0
    started = time.monotonic()
    for step in range(round(seconds * 50)):
        if step:
            observer.advance(samples)
            obs = observer.compute(motion, min(step, len(motion.q)-1), data.qpos[3:7], data.qvel[3:6], filt.history, step, 10)
        else:
            obs = np.zeros(392, np.float32)
        filt.start(student.action(obs))
        for sub in range(4):
            state = SimpleNamespace(q=data.qpos[qids], dq=data.qvel[vids])
            target, kp, kd, _ = guard_target(filt.target(), state, mf, {'joint_margin_radians': .02})
            data.ctrl[:] = target[order]
            model.actuator_gainprm[:, 0] = kp[order]
            model.actuator_biasprm[:, 1] = -kp[order]
            model.actuator_biasprm[:, 2] = -kd[order]
            mj.mj_forward(model, data)
            if step >= 100:
                # The velocity of the actual contact point, not foot-origin
                # translation (which also includes legitimate foot rocking).
                for cid in range(data.ncon):
                    c = data.contact[cid]
                    if ground not in c.geom:
                        continue
                    other = int(c.geom[1] if c.geom[0] == ground else c.geom[0])
                    body = int(model.geom_bodyid[other])
                    if body not in feet:
                        continue
                    force = np.zeros(6)
                    mj.mj_contactForce(model, data, cid, force)
                    if force[0] <= 5:
                        continue
                    jac = np.zeros((3, model.nv))
                    mj.mj_jac(model, data, jac, None, c.pos, body)
                    v = np.asarray(c.frame).reshape(3, 3) @ (jac @ data.qvel)
                    velocities.append(float(np.linalg.norm(v[1:])))
                    ratio = np.linalg.norm(force[1:3]) / (c.friction[0] * force[0])
                    utilization.append(float(ratio))
                    normals.append(float(force[0]))
                    saturated += ratio > .95
            for _ in range(round(.005/model.opt.timestep)):
                mj.mj_step(model, data)
            samples = [samples[1], data.qpos[qids].copy()]
        mj.mj_forward(model, data)
        if step % 10 == 0:
            trace.append({'t': (step+1)*.02, 'root': data.qpos[:3].tolist(), 'feet': data.xpos[feet].tolist()})
        if not np.isfinite(data.qpos).all():
            raise ValueError('Non-finite physics state')
    v = np.asarray(velocities)
    positions = np.array([r['feet'] for r in trace if r['t'] >= 2])
    drift = np.linalg.norm(positions[-1, :, :2] - positions[0, :, :2], axis=1)
    return {'variant': variant, 'seconds': seconds, 'contact_mu': float(model.geom_friction[ground, 0]),
            'cone': int(model.opt.cone), 'impratio': model.opt.impratio, 'noslip_iterations': model.opt.noslip_iterations, 'physics_dt': model.opt.timestep,
            'contact_tangent_speed_mm_s': {'p50': float(np.percentile(v, 50)*1000), 'p95': float(np.percentile(v, 95)*1000), 'max': float(v.max()*1000)},
            'friction_utilization_p95': float(np.percentile(utilization, 95)), 'friction_saturation_fraction': saturated/len(v),
            'loaded_contacts': len(v), 'foot_origin_drift_after_2s_mm': (drift*1000).tolist(),
            'final_root': data.qpos[:3].tolist(), 'wall_seconds': time.monotonic()-started, 'trace': trace}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--seconds', type=float, default=20)
    p.add_argument('--variants', nargs='+', default=['baseline', 'mu3', 'elliptic10', 'elliptic100', 'noslip5', 'elliptic10-noslip5'])
    p.add_argument('--output', default='test-results/contact-audit.json')
    args = p.parse_args()
    config = json.loads((ASSETS/'config.json').read_text())
    raw = json.loads((ASSETS/'stand.json').read_text())
    motion = Motion(raw['joint_pos'], raw['root_pos'], raw['root_quat'], raw['joint_vel'], raw['root_lin_vel'], raw['root_ang_vel'])
    student = Student('/home/mapinxuan/gentle-r1/results/deployment/student')
    results = []
    for variant in args.variants:
        result = run(student, config, motion, variant, args.seconds)
        results.append(result)
        print(json.dumps({k:v for k,v in result.items() if k != 'trace'}), flush=True)
    output = ROOT/args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'mujoco': mj.__version__, 'source_model': 'frozen deployment/student/mujoco/r1.xml', 'model_sha256': hashlib.sha256(SOURCE_MODEL.read_bytes()).hexdigest(),
                                  'checkpoint_sha256': config['checkpoint_sha256'], 'window_note': 'Loaded ground-foot contacts after initial 2 seconds; no external force.', 'results': results}, indent=2)+'\n')


if __name__ == '__main__':
    main()
