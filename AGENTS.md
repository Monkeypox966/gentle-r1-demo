# Gentle R1 browser demo

- Static GitHub Pages site for Monkeypox966. Publishing is explicitly authorized by the owner.
- Training project `/home/mapinxuan/gentle-r1` is read-only except adding documentation/results links. Never change its training source, configuration, checkpoints, data or simulator lock inode.
- Freeze student checkpoint SHA 61a5b331557f8e031de4f05fd71b48f58892e8d020578eaaeb1ea45f104af9c5; ONNX includes normalization. Policy 392 -> 24, model 26 joints. Reference URDF order, measured-history BFS order and action BFS order are distinct.
- Use official MuJoCo 3.12.0 WASM. Existing MJCF has position actuators: write joint targets, not external PD torques. Head stays at zero. 50Hz policy, 200Hz target filter/history sampling, 1000Hz physics (5 physics steps per target), fixed dt. Browser contact model uses elliptic cone, impratio 10 and noslip 20 at unchanged friction 1.0; the original deployment/evaluation model is read-only.
- Tests on this 32GB host exclude CPU1, use bounded systemd user scopes and the training project's simulator lock. Browser QA uses software WebGL/SwiftShader, never NVIDIA/Kit.
- npm environment is local; Node is in `/home/mapinxuan/.local/opt/node-v24.22.2-linux-x64/bin`. No sudo, no global Python/npm installs.
- Browser assets are self-contained, all network paths respect `/gentle-r1-demo/`. Include source/model/data provenance and upstream notices. Never publish datasets whose redistribution terms have not been checked.
- Verify raw observation/action parity, physical closed-loop behaviour and production subpath loading before publishing. Keep compact validation evidence, clean disposable files, update README and the training project's website guide.

- UI is a plain full-height viewport + experiment panel. No hero, marketing banner, top navigation/footer or metric cards. Direct robot dragging applies force; blank-area dragging orbits. World camera fixed by default. Simulation has no clip-duration stop; 10-second references wrap with continuous lookahead, physics/filter/history/boot time never reset at the seam. Springs persist while enabled. Runtime config and model use hashed filenames to avoid stale contact-model caches.

- Pages publishing uses `.github/scripts/deploy-pages.mjs`, official artifact/OIDC authorization, actions:read/pages:write/id-token:write, and a bounded 25-minute status monitor (30-minute job). Two deploy-pages@v4 attempts timed out during backend sync at its hard 10-minute maximum; source/model/browser tests passed. Keep failures visible, do not publish before browser acceptance or falsely report a pending deployment as live.

- Motion-switch regression: analytic endpoint velocities, hashed motion assets, latest-request-wins, rollback to active selection on error, no play/reset while loading. Never equate a chosen dropdown option or completed rollout with a successful motion switch: assert sim.motionId, policy target input and actual arm motion; previous raise/reach labels were false positives. Frozen training/weights unchanged.
