# Gentle R1 — 浏览器仿真

[打开网页演示](https://monkeypox966.github.io/gentle-r1-demo/) · [验证记录](docs/VALIDATION.md) · [资源来源](ASSET_PROVENANCE.json) · [致谢与许可](public/THIRD_PARTY_NOTICES.md)

R1 柔顺与非柔顺运动跟踪策略的纯浏览器闭环演示。MuJoCo 3.12 WASM 推进真实动力学，ONNX Runtime Web 执行已训练的冻结学生策略，Three.js 渲染当前仿真状态。无需 Python 服务、GPU 服务器、SSH 或串流客户端。

![实际浏览器步行截图](docs/dynamic-walk.png)

## 使用

建议使用桌面版 Chrome 或 Edge。资源加载完毕后会弹出鼠标施力提示；关闭提示，选择动作并点击“运行策略”。资源未压缩体积约 50 MB，实际传输量随站点压缩和浏览器缓存而变。

首次引导以大字与简短说明叠在淡化的仿真场景上；点击任意处、“开始体验”或按Esc淡出关闭。支持手机布局与减少动态效果设置。

- 七种参考：自然站立、双臂抬起、双臂前伸、双臂挥动、转腰摆臂、连续浅蹲、向前步行。建议先体验向前步行或双臂挥动，并在运动中拖动手臂。
- 策略可选“柔顺 · Gentle”或“非柔顺 · Vanilla-RL”。它们运行不同的已训练网络，使用相同网页动力学与参考动作；切换时保留动作选择，复位物理状态和历史缓冲，运行中的仿真随后自动继续。
- 参考周期为10秒，仿真持续运行，没有10秒停止限制；循环时不复位物理状态。步行参考以0.18 m/s前进，循环后延续位移，相机随行；其他动作相机默认固定。
- 直接拖动机器人施力，拖动空白区域旋转视角，滚轮缩放。不需要Shift或切换施力模式；松开撤力。
- 运行中选择新动作会载入、复位并自动继续；加载失败时恢复真实生效的选项并显示错误。
- 可开启腕部弹簧，或点击“轻推 10 N”；箭头和曲线显示施加的外力。
- 5–15 N 滑块改变柔顺网络的力条件，不是实际接触力的保证上限。非柔顺策略下禁用滑块并固定该输入为10；鼠标拖动、弹簧和轻推仍可使用。
- 可查看参考叠影、暂停、复位和调整播放速度；隐藏标签页自动暂停。可持续运行至手动暂停或触发保护。

所有推理和物理计算均在访问者的浏览器中完成。50 Hz 是固定的仿真控制频率；性能不足时墙钟运行速度会降低，不跳过物理步，也不改变策略时间步。

## 冻结策略

| 项目 | 值 |
|---|---|
| 机器人 | Unitree R1，26 物理关节，24 策略动作 |
| 观测 | 392 维；归一化已封装在 ONNX 中 |
| 策略 / 目标滤波 / 动力学 | 50 Hz / 200 Hz / 1,000 Hz，位置执行器 |
| 头部 | PD 保持零位，不接收策略动作 |
| 柔顺 Checkpoint SHA256 | `61a5b331557f8e031de4f05fd71b48f58892e8d020578eaaeb1ea45f104af9c5` |
| 柔顺 ONNX SHA256 | `726ca9fd62520498125186e19a5fbc1d9e8d6607245852ca91cb167592d6df21` |
| 非柔顺 Checkpoint SHA256 | `e63de50193964dd0adb4f8009702f77d2bacfc72a9466106efd5a80c4fab1151` |
| 非柔顺 ONNX SHA256 | `99566d84319ce33af332b41add2cf1bcd8a76122397c55ac0a58c49c21159916` |

Teacher / Adapt / Finetune 的训练预算分别为 40 / 10 / 20 亿帧，实际完成 6,999,588,864 帧。该策略迁移自 GentleHumanoid 方法，不是原论文 G1 的严格复现。

Vanilla-RL使用原始参考训练，不生成柔顺目标、不施加训练外力；它也完成相同三阶段预算，并非调大PD得到的“刚性模式”。默认柔顺策略为历史v2，Vanilla为修复了训练边界后的v3，因此网页体验不能当作严格控制变量的消融。来源、导出和切换验证见[双策略说明](docs/POLICY_SWITCH.md)。

网页参考动作是本项目自主生成的平滑目标轨迹，未打包 LAFAN、AMASS、InterX 或其他原始训练动作数据。浅蹲与步行用R1足端约束逆运动学构造；动作参数经同一冻结策略筛选，定位为精选能力演示，不是未见动捕数据的泛化评测。机器人由策略与物理引擎控制，并非直接播放目标姿态动画。有限的浏览器演示不代替完整策略评估，亦不构成实机或人体接触验收。设计与结果见[动态动作](docs/DYNAMIC_MOTIONS.md)。

网页仅保留三维视口与控制面板。步行时相机随行；地面网格始终固定在世界坐标。

脚底漂移排查见[接触诊断](docs/CONTACT_AUDIT.md)：保留摩擦系数1.0，细化网页接触积分并使用椭圆摩擦锥、NoSlip20。模型选项与原始部署包不同，有显式来源记录；原训练、冻结评估与权重未改动，也没有锁脚或外加位姿修正。

## 本地开发

需要 Node.js 24 LTS。构建只需要仓库内已导出的资源，不需要下载训练数据或安装 Python。

```bash
npm ci
npm test
npm run dev
```

使用终端显示的 `http://127.0.0.1:5173/gentle-r1-demo/` 地址。验证生产构建：

```bash
npm run build
npm run preview -- --port 4173
# 在另一个终端中：
npx playwright install chromium --only-shell
npm run test:browser
```

测试覆盖 Python 对照观测、动作滤波、两策略冻结资产 SHA 与独立 ONNX 数值对照、柔顺策略14组各22秒闭环、非柔顺策略七动作各12秒闭环、60秒WASM站立漂移、真实鼠标施力、加载失败回退、策略/动作交错切换、加载提示及移动布局。浏览器测试使用软件 WebGL，无需 NVIDIA GPU。

本项目服务器上的计算请使用 `bash scripts/resource.sh <命令>`，它排除 CPU1、限制内存并持有全局仿真锁。其他机器可直接使用 npm 命令；不要照搬本机绝对路径。`scripts/export-assets.py` 仅供从本机冻结部署包重新导出，不参与网页或 GitHub Actions 构建。

`scripts/export-vanilla-policy.py`从只读Vanilla最终检查点独立导出网络、Python对照与资源索引；它不覆盖Gentle模型或原有对照数据。原资源导出脚本会保留已导出的附加策略。

## 结构与发布

```text
src/control.js         观测、四种关节顺序映射、滤波、关节/姿态保护
src/simulation.js      ONNX 推理、MuJoCo 闭环、弹簧与交互外力
src/viewer.js          当前物理状态渲染、参考叠影、鼠标拾取施力
src/main.js            UI 与不重入的异步控制循环
public/assets/r1/      冻结 ONNX、MuJoCo XML/mesh、自主生成的参考
public/licenses/       第三方许可证与通知
tests/                 Python 导出的数值对照与真实浏览器验收
docs/                  精简验证记录与实际截图
```

推送 `main` 的代码或资源更新后，GitHub Actions 自动执行单元测试、构建与真实浏览器验收，全部通过后发布 GitHub Pages。仅更新README、AGENTS或docs不会重新部署。发布器使用官方Pages API及OIDC授权，最长等待25分钟；只有确认成功才标记发布完成，失败/取消时清理本次部署。WASM 使用单线程，不依赖 GitHub Pages 无法自定义的跨源隔离响应头。所有运行资源同源托管，没有 CDN 运行依赖。

修改仓库名时必须同步 `vite.config.js` 的 `base`、测试地址及文档链接。训练代码、数据与历史记录仍在独立的 `gentle-r1` 项目中；本仓库不会启动或改变训练。

## 来源

[GentleHumanoid](https://gentle-humanoid.axell.top/) 提供研究方法；[humanoid-policy-viewer](https://github.com/Axellwppr/humanoid-policy-viewer) 和 [mujoco_wasm](https://github.com/zalo/mujoco_wasm/) 提供网页交互与渲染参考。R1 控制层依据本项目的 Python 部署契约重新实现。使用官方 MuJoCo、ONNX Runtime Web、Three.js 与 Unitree 模型；详见第三方许可。

动作切换修正与真实手臂运动证据见[修正记录](docs/MOTION_SWITCH_FIX.md)。旧测试只检查仿真存活，不能证明动作切换；现要求实际动作ID、策略输入和双臂关节运动均匹配，并覆盖加载失败与乱序返回。
