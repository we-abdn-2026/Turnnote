# #5 / #6 音频验证记录

## 实现基线

- 起点：dev `469d5fc5776a5f7da2da6c1b93a05d1962e2ab65`。
- 分支：`feat/audio-capture-writer`。记录适用于本次实现；提交 revision 由 PR 指向的 commit 确定。
- 共享 contracts、IPC 通道和数据库 schema 均未修改。
- ASR 自动启动属于 #7，目前录音 stop 正确停留在 captured，Main 提供 afterCapture 接入点。

## macOS 实际采集（2026-10-11，Asia/Shanghai）

| 项目 | 结果 |
| --- | --- |
| 系统 / 架构 | macOS 26.6.2 (25G83) / arm64 |
| Electron / Chromium | Electron 44.4.5（Chromium 随该发行版） |
| 音频库 | electron-audio-loopback 1.0.6 |
| 启动方式 | `npm run dev`，真实 Electron 窗口，非 dev:web/mock |
| 来源选择 | Microphone + System audio 均勾选 |
| 权限情况 | 实际获取两路 MediaStream 成功，无系统音频降级警告；本轮没有新的权限弹窗。未单独导出系统设置截图 |
| 声音刺激 | 在本机浏览器播放 35 秒、440/880 Hz 交替测试音 |
| 完成状态 | 点击 Stop and save 后界面显示 Recording saved，Main 提交 captured |
| 原始时长 | 77.488 秒（包含准备测试音和操作界面的时间） |
| 交付片段 | 从原始文件第 22 秒开始截取连续 30 秒；不是合成或 mock 数据 |
| WAV 格式 | 16000 Hz / 单声道 / 16-bit PCM，文件可由 Python wave 解码 |
| 片段幅度 | peak 3523 / RMS 660.996（Int16 单位），非静音 |
| 片段 SHA-256 | b6f7ed66712ede5166f7fbb211cb9a13d40198afb8620e25a7b5bb9b39f68cf6 |

原始录音、30 秒片段及 metrics.json 位于本地 `artifacts/local-audio/`，已加入 gitignore，不自动上传录音或本机路径。复核者可在用户确认音频适合分享后取得片段。本次验证证明真实采集和 WAV 写入链路工作，未做两路来源的独立声学归因，也未验证真实转写。

## 自动验证

- `npm run typecheck`：通过。
- `npm run lint:js`：通过；Python 未修改，完整 lint 的 ruff 部分另行记录。
- `npm test`：72 项全部通过，含最初 12 项音频与采集流程测试，以及审核后新增的 8 项异常流程回归测试。
- `npm run build`：Main、Preload、Renderer 和独立 AudioWorklet 构建通过。
- `npm run test:electron`：Electron 44.4.5 / Node 24.21.0 的 SQLite 加载、迁移和持久化通过。

音频测试覆盖 WAV 小端样本、偏移视图、header 长度、重复 finalize、截断修复、空/未知文件拒绝、实际短写/磁盘异常模拟、jobId 隔离、停止/取消竞态、启动恢复、删除失败保留引用、重采样时长、混音和末块。Renderer 流程测试验证末块写入先于 stop、权限拒绝后的资源释放、系统音频降级和 WRITE_FAILED；浏览器替身不作为实际采集证据。

## 审核问题修复（2026-10-11）

- P1：资源释放仅按内存中的活动 writer 归属操作，不查询会排除删除墓碑的 getJobs；带墓碑的删除重试和重启恢复可以完成。使用真实 SQLite 和文件系统验证删除失败、恢复、再次删除及启动清理的组合路径。
- P2：取得音轨后立即监听 ended，在媒体请求、Worklet 加载和 AudioContext 恢复后检查音轨状态；初始化期间失效不会返回成功，晚到的麦克风也会释放。
- P2：清理只执行一次，已关闭的 AudioContext 不再次关闭；显式 cancel 等待失败收尾，但不会被之前 stop 的错误阻断。覆盖音轨失效、processorerror 和 WRITE_FAILED 后的取消。
- 本轮 typecheck、lint:js、build 和 72 项测试通过。新增媒体生命周期测试使用替身，不算新增真机录音证据；前述 macOS 记录属于初次提交。

## 工作区采集接线修复（2026-10-12）

- 删除顶部独立录音入口，工作区当前会议持有唯一的采集会话；保留参会者告知确认，停止先 flush PCM 再提交 Main stop，业务状态仍来自 Main 快照和事件。
- 每次启动从 Main 读取已保存的设备设置；默认麦克风设置不会被解释成禁用麦克风，设置读取失败时不启动录音。系统音频降级警告和采集错误由工作区展示。
- dev:web 显式使用模拟录音 adapter，不请求真实媒体；桌面 App 默认使用真实采集 adapter。
- 新增生产 App → IPC dispatcher → Main recording/storage → SQLite/WAV 集成回归，使用受控媒体验证选定设备、单会议归属和非空 PCM；同时覆盖设置/权限失败、丢弃重录、初始化和活动录音时卸载。采集测试共用媒体 fixture。
- 本轮 lint、typecheck、build 通过；`npm test` 为 185 通过、10 跳过（缺少 faster-whisper / 真实模型），`npm run test:ui` 为 15/15 通过。
- 此轮自动回归不构成新增 macOS/Windows 真机采集证据；前述 macOS 记录保留为原始提交的历史验证。

## 尚需验收

- Windows：本机没有 Windows 运行环境，未验证真实麦克风/系统音频或权限行为。
- macOS 安装包：当前仅开发模式验证；Info.plist 权限声明及安装包权限行为需打包任务验证。
- 在目标设备确认权限拒绝、设备拔出、系统音频不可用的真实行为；CI 中对应流程只有替身测试。
- #3 的契约人工审核、远端 CI 和团队 PR 审批需按仓库规则完成。

## Windows 手动验收步骤

1. 从任务分支安装依赖，运行 `npm run dev`；记录 Windows 版本、CPU 架构、Electron 版本及麦克风权限。
2. 在设备设置中选择麦克风并开启系统音频；新建会议、确认已告知参会者后开始录音。播放非私密测试音，并说一段测试语句，录制至少 30 秒后点击“停止录音”。
3. 在应用管理目录找到本次 WAV，用播放器或 Python wave 解码；确认 16000 Hz、单声道、16-bit、header 长度与数据一致，且能听见两种测试声。
4. 再测试麦克风拒绝、设备不可用、系统音频不可用；确认明确提示和 failed/降级结果，没有虚假 recording。
5. 测试停止、丢弃、连续重新录制、关闭应用和重启恢复；记录实际命令、commit、结果和可分享产物。
