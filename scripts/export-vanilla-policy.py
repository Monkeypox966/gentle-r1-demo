"""Add a separately trained Vanilla student without changing Gentle assets."""
from pathlib import Path
import hashlib
import json
import os
import sys
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TRAINING = Path('/home/mapinxuan/gentle-r1')
sys.path[:0] = [str(TRAINING), str(TRAINING / 'deployment')]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    if 1 in os.sched_getaffinity(0):
        raise RuntimeError('Use scripts/resource.sh with CPU1 excluded')
    import torch
    import onnx
    import onnxruntime as ort
    from scripts.evaluation.mujoco.evaluate import FrozenStudent
    from scripts.deployment.export import plain_student
    from gentle_r1_deploy.schema import PHYSICAL, OBSERVATION, REFERENCE, ACTION

    torch.set_num_threads(1)
    checkpoint = TRAINING / 'results/vanilla_rl/checkpoints/student.pt'
    checkpoint_sha = 'e63de50193964dd0adb4f8009702f77d2bacfc72a9466106efd5a80c4fab1151'
    assert digest(checkpoint) == checkpoint_sha
    frozen = FrozenStudent(checkpoint)
    assert frozen.state['cfg'].task.name == 'R1NOFORCE'
    assert frozen.state['policy']['last_phase'] == 'finetune'
    assert frozen.state['training']['env_frames'] == 1999798272
    assets = ROOT / 'public/assets/r1'
    cfg = json.loads((assets / 'config.json').read_text())
    for key, expected in [('physical_joint_names', PHYSICAL), ('observation_joint_names', OBSERVATION),
                          ('reference_joint_names', REFERENCE), ('action_joint_names', ACTION)]:
        assert cfg[key] == list(expected), key
    assert digest(assets / 'policy.onnx') == cfg['onnx_sha256']
    cases = json.loads((ROOT / 'tests/fixtures/policy.json').read_text())
    net = plain_student(frozen)
    with tempfile.TemporaryDirectory(prefix='vanilla-export-', dir=ROOT / '.cache') as temp:
        path = Path(temp) / 'policy.onnx'
        with torch.inference_mode():
            torch.onnx.export(net, (torch.zeros(1, 392),), str(path), input_names=['observation'],
                              output_names=['action'], opset_version=17, dynamo=False, external_data=False)
        onnx.checker.check_model(onnx.load(str(path)))
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
        rng = np.random.default_rng(20261111)
        samples = [np.asarray(c['observation'], np.float32) for c in cases]
        samples += [np.zeros(392, np.float32)]
        samples += [rng.normal(size=392).astype(np.float32) * scale for scale in [.01, .1, 1, 10] for _ in range(8)]
        errors = []
        for obs in samples:
            expected = frozen.action(obs)[0]
            actual = session.run(None, {'observation': obs[None]})[0][0]
            np.testing.assert_allclose(actual, expected, atol=2e-5, rtol=2e-5)
            errors.append(float(np.max(np.abs(actual - expected))))
        onnx_sha = digest(path)
        filename = f'policy-vanilla-{onnx_sha[:12]}.onnx'
        (assets / filename).write_bytes(path.read_bytes())
    # Independent PyTorch oracle; do not overwrite the frozen Gentle oracle.
    oracle = [{'observation': c['observation'],
               'expected_action': np.clip(frozen.action(c['observation'])[0], -10, 10).tolist()} for c in cases]
    (ROOT / 'tests/fixtures/policy-vanilla.json').write_text(json.dumps(oracle, separators=(',', ':')) + '\n')
    cfg['default_policy'] = 'gentle'
    cfg['policies'] = [
        {'id': 'gentle', 'label': '柔顺 · Gentle', 'description': '使用柔顺参考训练，允许在外力下让步。',
         'file': 'policy.onnx', 'onnx_sha256': cfg['onnx_sha256'], 'checkpoint_sha256': cfg['checkpoint_sha256'],
         'training_semantics_version': 2, 'force_conditioned': True},
        {'id': 'vanilla', 'label': '非柔顺 · Vanilla-RL', 'description': '跟踪原始参考，不使用柔顺目标训练。',
         'file': filename, 'onnx_sha256': onnx_sha, 'checkpoint_sha256': checkpoint_sha,
         'training_semantics_version': 3, 'force_conditioned': False},
    ]
    cfg['files'] = {str(p.relative_to(assets)): digest(p) for p in sorted(assets.rglob('*'))
                    if p.is_file() and not (p.parent == assets and p.name.startswith('config'))}
    (assets / 'config.json').write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n')
    config_name = f'config-{digest(assets / "config.json")[:12]}.json'
    for old in assets.glob('config-*.json'):
        old.unlink()
    (assets / config_name).write_bytes((assets / 'config.json').read_bytes())
    (ROOT / 'src/bundle.js').write_text('// Generated asset-version boundary.\n' + f'export const CONFIG_FILE = "{config_name}";\n')
    provenance = json.loads((ROOT / 'ASSET_PROVENANCE.json').read_text())
    provenance.update(policies=cfg['policies'], assets=cfg['files'],
                      comparison_note='Two independently trained policies; Gentle v2 and Vanilla v3 differ in environment fixes, so this is not a controlled ablation.')
    (ROOT / 'ASSET_PROVENANCE.json').write_text(json.dumps(provenance, indent=2, ensure_ascii=False) + '\n')
    report = {'checkpoint_sha256': checkpoint_sha, 'onnx_sha256': onnx_sha,
              'parity_observations': len(samples), 'max_absolute_action_error': max(errors),
              'gentle_onnx_unchanged': digest(assets / 'policy.onnx') == cfg['onnx_sha256'],
              'checkpoint_unchanged': digest(checkpoint) == checkpoint_sha}
    (ROOT / 'docs/vanilla-export.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
