# Attribution and licenses

The original browser application and synthetic reference motions are provided under the repository's BSD-3-Clause license. Third-party material retains its own license; this notice does not relicense upstream research code or datasets. The frozen R1 weights are published by their trainer, Monkeypox966, for this research demo under the repository license.

| Component / reference | Attribution | License copy |
|---|---|---|
| [GentleHumanoid research](https://gentle-humanoid.axell.top/) | Original method and training architecture; R1-specific adaptation and weights trained separately | No upstream training code or training datasets redistributed here |
| [humanoid-policy-viewer](https://github.com/Axellwppr/humanoid-policy-viewer) | Copyright (c) 2026, Qingzhou Lu. Interaction/control-flow reference; R1 browser controller rewritten | [BSD-3-Clause](licenses/viewer.txt) |
| [mujoco_wasm](https://github.com/zalo/mujoco_wasm/) | Copyright (c) 2017 Konstantin Gredeskoul. Mesh-to-Three.js rendering reference; copied mesh buffers, Z-up transforms, picking and R1 rendering adapted | [MIT](licenses/zalo.txt) |
| [MuJoCo](https://github.com/google-deepmind/mujoco) 3.12.0 | Google DeepMind; official unmodified single-thread WASM runtime | [Apache-2.0](licenses/mujoco.txt) |
| [Three.js](https://github.com/mrdoob/three.js) 0.181.0 | three.js authors | [MIT](licenses/three.txt) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.26.0 | Microsoft Corporation | [MIT](licenses/ort.txt), [third-party notices](licenses/ort-third-party.txt) |
| [Unitree ROS R1 description](https://github.com/unitreerobotics/unitree_ros) | Copyright (c) 2016–2022 HangZhou YuShu TECHNOLOGY CO., LTD. (Unitree Robotics). R1 meshes; derived MJCF has floating base, position servos and explicit browser contact refinement (1 ms integration, elliptic cone, impratio 10, NoSlip20; unchanged friction 1.0) | [BSD-3-Clause](licenses/unitree.txt) |

The original synthetic stand/raise/reach/wave/twist/squat/walk reference JSON files contain no excerpts from LAFAN, AMASS, InterX or the original viewer's recorded motions. Squat and walk use authored foot paths and R1 inverse kinematics; no captured motion is an input to their generator. Training dataset licenses are not extended by this repository. Names and trademarks identify research and model sources; no endorsement is implied.

Source/asset hashes are recorded in `ASSET_PROVENANCE.json` in the source repository. Dependency versions and package integrity values are pinned in `package-lock.json`.
