# 开发路线图

时间以 [proposal.md](../proposal.md) 的 Timeline 为准。Phase 1–2（需求、架构、技术验证）已结束，本文覆盖 Phase 3–6：2026-09-30 至 2026-11-26。

## 里程碑

| 里程碑 | 日期 | 交付物 |
|---|---|---|
| Phase 3 · W1 | 09-30 – 10-06 | IPC 契约冻结；数据库；sidecar 真实转写；音频采集；打包验证 |
| Phase 3 · W2 | 10-07 – 10-13 | 录音到纪要主流程；DeepSeek 集成；关键词引导 |
| Phase 3 · W3 | 10-14 – 10-20 | 会议管理、编辑、导出、时间戳跳转；**功能冻结** |
| Phase 4 | 10-21 – 11-10 | 模块测试；缺陷修复；错误处理；两平台安装包 |
| Phase 5 | 11-11 – 11-20 | 端到端集成；真机矩阵；pilot 评估 |
| Phase 6 | 11-21 – 11-26 | 发布 MVP；文档；答辩 |

Phase 3 结束后只修缺陷，不加功能。

## 分工规则

- 跨前后端的功能由一个负责人端到端交付，另一组配合。
- 单元测试由实现者编写；测试组负责测试基础设施、真机矩阵和 pilot。
- `packages/contracts` 的变更需前端和后端各一人审核。
- Phase 3 · W1 前两天前后端确认 IPC 契约；前端基于 `npm run dev:web` 的 mock 并行开发。

## 模块

| 分组 | 模块 | 范围 |
|---|---|---|
| 前端 | 录音工作区 | 设备选择、录音控制、状态指示、转写查看 |
| 前端 | 纪要编辑 | 纪要展示与编辑、关键词标注、时间戳跳转 |
| 前端 | 会议库和设置 | 列表、搜索、重命名、删除、设置、API Key |
| 后端 | 音频采集链路 | Renderer 采集、`AudioWriter`、权限（端到端负责） |
| 后端 | ASR sidecar | faster-whisper 转写、sidecar 生命周期 |
| 后端 | 存储和会话编排 | 数据库、状态机、崩溃恢复、音频保留、导出 |
| 后端 | DeepSeek 和凭证 | 纪要生成、分段合并、重试、`safeStorage` |
| 测试 | 测试基础设施 | 样本音频、DeepSeek mock、集成测试 |
| 测试 | 真机和 pilot | 平台矩阵、性能基线、pilot 评估 |
| 部署 | 打包 | macOS / Windows 安装包、打包 CI |

## 后端任务

### Phase 3 · W1
- [ ] 实现 `storage/` 数据库层（schema、migrations、CRUD、状态机）
- [ ] 集成 `electron-audio-loopback`，实现 Renderer 音频采集（麦克风 + 系统音频混音、16kHz 重采样）
- [ ] 实现 Main Process `AudioWriter`（IPC 接收 PCM 分块、写入 WAV、header 修复）
- [ ] 实现 sidecar 生命周期管理（spawn、ping、超时、崩溃处理、`TURNNOTE_ASR_FAKE`）
- [ ] 实现 sidecar 真实转写（faster-whisper）

**验收**：录制 30 秒音频保存为 WAV，sidecar 返回带时间戳的转写片段，存入数据库。

### Phase 3 · W2
- [ ] 实现 DeepSeek API 客户端（`services/deepseek.ts`）
- [ ] 实现 prompt 模板和结构化输出 schema 校验
- [ ] 实现长文本分段和中间摘要合并
- [ ] 实现 API 重试、限流、超时处理
- [ ] 实现系统凭证存储 API Key（Electron `safeStorage`）
- [ ] 实现关键词引导生成；决策和行动项返回来源 `timestampMs`

**验收**：转写完成后生成结构化纪要，存入 `note_versions`。标注"定价"关键词后重新生成，纪要优先扩展定价相关讨论。

### Phase 3 · W3
- [ ] 实现会议列表查询、搜索、重命名、删除
- [ ] 实现音频保留/删除逻辑和崩溃恢复
- [ ] 实现 Markdown 导出（标题、时间、纪要内容）
- [ ] 实现纪要编辑版本管理和持久化

**验收**：可搜索会议、编辑纪要、导出 Markdown、删除会议并清理关联文件。

### Phase 4
- [ ] 实现安全日志（过滤凭证、路径和会议正文）
- [ ] 实现错误码到用户可见信息的映射
- [ ] 修复模块测试发现的缺陷

### Phase 5
- [ ] 修复端到端和真机测试发现的跨平台缺陷

**验收**：macOS 13+ 和 Windows 10 22H2+ 上完成录音、转写、生成、编辑、导出全流程。

## 前端任务

### Phase 3 · W1
- [ ] 实现音频设备选择界面（麦克风、系统音频）
- [ ] 实现录音控制按钮和状态指示器
- [ ] 实现会议创建和录音状态实时更新

**验收**：mock 下完成创建会议、开始/停止录音，界面状态随事件更新。

### Phase 3 · W2
- [ ] 实现转写片段列表（时间戳 + 文本）
- [ ] 实现处理状态界面（transcribing、generating 进度）
- [ ] 实现纪要结构化展示（summary、decisions、actionItems）
- [ ] 实现 DeepSeek 数据发送提示和确认
- [ ] 实现关键词标注 UI 和"重新生成"

**验收**：可查看转写和纪要，明确知道哪些数据发送给 DeepSeek，可标注关键词并重新生成。

### Phase 3 · W3
- [ ] 实现会议列表和搜索
- [ ] 实现纪要编辑器
- [ ] 实现设置界面（模型、语言、API Key）
- [ ] 实现导出按钮
- [ ] 实现音频保留选项和删除确认
- [ ] 实现决策/行动项点击跳转到对应转写片段

**验收**：可编辑并保存纪要、设置 API Key、导出、删除会议；点击纪要内容跳转到转写位置。

### Phase 4
- [ ] 实现错误提示和重试入口
- [ ] 统一两平台布局和视觉

**验收**：每个错误码有清晰提示和恢复操作。

### Phase 6
- [ ] 录制演示视频和用户指南截图

## 测试任务

### Phase 3 · W1
- [ ] 准备中英文样本音频（10–30 秒，自行录制，放入 `tests/fixtures/`）
- [ ] 实现 DeepSeek mock server（正常、限流、超时、无效 JSON）

### Phase 3 · W2–W3
- [ ] 编写 Main 服务集成测试（fake sidecar + DeepSeek mock：录音 → 转写 → 生成 → 导出）
- [ ] 编写崩溃恢复测试（中断录音、转写、生成）

**验收**：集成测试在 CI 中运行，覆盖正常和失败路径。

### Phase 4
- [ ] 真机测试矩阵（macOS 13/14/15 arm64 与 x64，Windows 10/11 x64）
- [ ] 长会议（1 小时音频）性能和内存
- [ ] 中英文转写质量基线

**验收**：矩阵结果、性能和质量基线形成文档。

### Phase 5
- [ ] 真机端到端测试（权限、长会议、睡眠唤醒、断网、删除、重启）
- [ ] 组织 pilot，统计 proposal 中的评估指标

**验收**：pilot 数据对照 proposal 目标（≥80% 独立完成流程、有用性 ≥4/5、DeepSeek 请求成功率 ≥95%）。

### Phase 6
- [ ] 整理已知问题清单

## 部署任务

### Phase 3 · W1
- [ ] 打包验证：空壳应用 + PyInstaller 打包的 sidecar + `better-sqlite3`，三个目标平台各出一个安装包

**验收**：三个安装包都能启动，并通过 sidecar `ping`。

### Phase 3 · W2–W3
- [ ] 配置 `electron-builder`（macOS DMG、Windows NSIS）
- [ ] 配置 PyInstaller 打包 sidecar（onedir，含 faster-whisper）
- [ ] 配置 `extraResources` 和原生模块重编译
- [ ] 打包 CI：macOS arm64、macOS x64、Windows x64 三平台构建安装包

**验收**：CI 产出三平台安装包。

### Phase 4
- [ ] 三平台安装包安装、启动、卸载测试

### Phase 6
- [ ] 产出发布安装包

**验收**：安装包可在 macOS 13+ 和 Windows 10 22H2+ 安装并运行。

PyInstaller 不能交叉编译，每个平台的安装包必须在对应平台和架构上构建。

## 外部依赖

| 依赖 | 状态 |
|---|---|
| DeepSeek API 测试密钥 | 必需 |
| 真机：macOS arm64、macOS x64、Windows x64 | 必需 |

## MVP 范围外

- 实时字幕
- 说话人分离
- 云同步和用户账号
- 日历集成和自动会议检测
- 协作和团队工作区
- Meeting bot
- 外部任务管理集成
- 视频录制
