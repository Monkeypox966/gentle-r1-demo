# Gentle R1 browser demo

- Static GitHub Pages site for Monkeypox966. Publishing is explicitly authorized by the owner.
- Training project `/home/mapinxuan/gentle-r1` is read-only except adding documentation/results links. Never change its training source, configuration, checkpoints, data or simulator lock inode.
- Freeze student checkpoint SHA 61a5b331557f8e031de4f05fd71b48f58892e8d020578eaaeb1ea45f104af9c5; ONNX includes normalization. Policy 392 -> 24, model 26 joints. Reference URDF order, measured-history BFS order and action BFS order are distinct.
- Use official MuJoCo 3.12.0 WASM. Existing MJCF has position actuators: write joint targets, not external PD torques. Head stays at zero. 50Hz policy, 200Hz filter/physics, fixed dt.
- Tests on this 32GB host exclude CPU1, use bounded systemd user scopes and the training project's simulator lock. Browser QA uses software WebGL/SwiftShader, never NVIDIA/Kit.
- npm environment is local; Node is in `/home/mapinxuan/.local/opt/node-v24.22.2-linux-x64/bin`. No sudo, no global Python/npm installs.
- Browser assets are self-contained, all network paths respect `/gentle-r1-demo/`. Include source/model/data provenance and upstream notices. Never publish datasets whose redistribution terms have not been checked.
- Verify raw observation/action parity, physical closed-loop behaviour and production subpath loading before publishing. Keep compact validation evidence, clean disposable files, update README and the training project's website guide.
