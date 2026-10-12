# W1 IPC 契约基线（#3）

本文件定义可供前后端并行开发的 v1 契约。类型、白名单和运行时 schema 的事实源分别是 `packages/contracts/src/contracts.ts`、`schemas/index.ts`；状态启动条件共用 `lifecycle.ts`。这是工程冻结候选，正式冻结仍须前端、后端各一人在 PR 留下审核记录；自动化检查不替代人工审核。

## 调用和所有权

- Renderer 仅使用 `window.turnnote`。Preload 通过 `createInvokeApi` 构造白名单，不暴露任意 invoke、文件路径或凭证读取入口。
- Main 在调用 handler 前执行共享 schema 校验；无效参数返回 `INVALID_INPUT`，合法但尚未实现的方法返回 `NOT_IMPLEMENTED`。
- Main 只接收窗口主 frame 的请求，阻止页面导航和新窗口。窗口保持 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`。
- 所有业务调用返回 `Result<T>`；预期错误使用共享安全错误目录，未知异常返回 `INTERNAL`。不得向 Renderer 或日志输出底层异常、路径、API Key 和会议正文。
- `loopback.enable/disable` 是第三方库固定通道，不返回 `Result`；Electron 中固定通道已接入库的平台初始化，并增加主 frame 校验及安全的采集拒绝结果。浏览器 mock 中为空操作。
- 本地状态和副作用归 Main；Python 不接触数据库、凭证和 DeepSeek。数据库提交完成后再发布事件。

## 状态、取消和失败

| 入口 | 成功返回／状态 | 失败或取消边界 |
|---|---|---|
| `meetings.create` | `created` | 标题为空或超限拒绝 |
| `recording.start` | `recording`，带 `activeJobId` | 仅 `created` 可录音；一份音频、一个活动任务 |
| `recording.appendChunk` | `null` | 只接受正在录音会议的 PCM16；失败后 Renderer 停止轨道并调用 `recording.fail` |
| `recording.stop` | 固定返回已提交的 `captured` 快照 | WAV finalize 完成后提交；随后 Main 自动启动转写，用事件报告 `transcribing`，不在响应中混用两种状态 |
| `recording.cancel` | 文件清理完成后返回 `created` | 允许录音中或失败阶段为 recording；丢弃当前音频，清理失败保留引用和可恢复数据 |
| `recording.fail` | `failed`，`lastError.kind=recording` | 仅接受采集四种错误码，由 Main 生成安全信息；保留音频，重录前显式 cancel |
| `meetings.importAudio` | 取消为 `null`；成功为 `captured` | Main 复制文件到管理目录，随后自动转写；Renderer 不提交路径 |
| `transcription.start` | `transcribing` | 只允许 captured 或 failed/transcribing，且音频引用存在；Main 启动前检查实际文件 |
| `transcription.cancel` | `captured` | 杀死进程、结束当前 job，不保存部分片段；音频保留 |
| `notes.generate` | `generating` | 只允许 transcribed、ready 或 failed/generating，且有非空转写；须具备凭证，由用户显式请求 |
| `notes.saveEdit` | 新 `NoteVersion` | 校验 schema 和 `expectedVersion`；旧版本返回 `CONFLICT`，不覆盖新编辑 |
| `meetings.delete` | `null` | 先提交 deleted 墓碑并取消任务，再清文件，最后级联删库；清理失败保留墓碑，列表和 get 不可见，允许重试 |

`lastError` 只在 failed 状态非空，包含失败 jobId 和 recording/transcribing/generating 的失败阶段。取消任务记为 cancelled，不能伪装成失败，也不自动发起重试。

保存编辑允许 transcribed、ready、generating 和 failed/generating。首次版本为 0；后续传入编辑时读到的 version。生成开始时保存 `base_note_version`；如果生成期间用户保存了新编辑，生成结果不得成为最新版本：数据库返回 `CONFLICT`，Main 将该生成 job 结束为 failed，保留用户版本和转写。

## 任务身份、事件和事务

- 每次启动或重试创建新的 job ID；同会议同阶段 attempt 递增。`MeetingDetail.activeJobId` 指向当前任务，结束后为 null。
- appendChunk、stop、recording.cancel/fail 和 transcription.cancel 必须携带启动时获得的 jobId。旧会话的 PCM、停止、失败或取消请求不得影响新任务；失败录音的显式丢弃使用 lastError.jobId。
- `onJobProgress` 包含 meetingId、jobId、kind 和 0–100 的整数 percent。Renderer 只显示 jobId 等于当前 activeJobId 的进度。
- Main 在转发进度和提交结果前调用 `store.isJobCurrent(jobId)`。取消、删除、失败或重试后的旧 ID 的完成／失败操作返回 false，不修改数据库、不发完成事件。单看会议状态不能区分旧任务和重试。
- ASR 片段先暂存在 Main；只有收到合法 done 才将全部片段、job completed 和 meeting transcribed 一次提交。
- 生成结果通过共享 schema 校验后，与 note version、job completed 和 meeting ready 一次提交。提交失败不得留下部分版本或假完成状态。
- 失败不删除音频、转写或已有纪要版本。数据库不做网络请求或自动生成，不在启动恢复时重试外部服务。
- Listener 收到独立快照；mock 使用同一参数校验和状态条件，任务令牌隔离旧异步循环，不承担生产副作用。

## 输入限制

标题 trim 后 1–200 字符；搜索 0–200；关键词最多 50 个，每个 1–100 字符并去重。meetingId 不允许路径分隔符。PCM 必须为非空 Int16Array，每块最多 32000 样本（16kHz 的两秒）。模型设置为长度不超过 100 的名称 token，不能作为任意路径。

纪要只接受 summary、keyTopics、decisions、openQuestions、actionItems，来源时间戳为非负安全整数。保存纪要拒绝多余字段。设置只允许五个非敏感字段，API Key 只能走 setApiKey/clearApiKey，不能写入 SQLite 或在响应中读取。

## 当前实现边界

| 环境 | 已实现 | 尚未实现 |
|---|---|---|
| Electron Main | 应用信息、会议元数据 CRUD/搜索/删除、录音生命周期、AudioWriter、loopback、自动/手动转写和取消、任务错误持久化、转写读取、纪要读取/编辑、非敏感设置持久化 | 音频导入、真实模型引擎（#8）、DeepSeek、凭证、导出 |
| 浏览器 mock | 全部业务接口的内存模拟、状态/失败/取消/进度/编辑冲突 | 真实录音、文件、数据库、外部 API |

`createSessionServices` 是 Electron 与集成测试共用的 Main 编排入口。recording.stop 在 WAV finalize 和 captured 提交后登记自动转写，再发布 captured；响应始终是该快照。手动启动、取消、删除和退出使待启动任务失效，旧任务的结果与进度按 jobId 丢弃。转写失败可通过 meetings.get 的 lastError 查询，音频不删除。

删除先提交墓碑，使正在执行或排队的任务失效，再等待 sidecar 和 AudioWriter 释放资源，最后删除文件和数据库记录。退出后拒绝新的业务请求，并等待所有已启动的 sidecar 结束后关闭数据库。转写成功后的音频自动清理仍属后续保留策略，当前保留成功音频。

## 冻结验证和后续变更

`tests/contracts.test.mjs` 检查 Preload 白名单、Main 参数校验、安全错误与 schema 完整性；`tests/mock-api.test.mjs` 检查取消/重试、停止返回状态、事件和编辑冲突；`tests/storage.test.mjs` 验证实际 SQLite 事务与重启持久化。

`tests/transcription-integration.test.mjs` 使用正式 Main 编排、共享 dispatcher、临时 SQLite 和文件目录，经 PCM IPC → WAV → 真实 worker --fake → 时间戳片段入库，验证失败、取消/重试、删除、退出、SQL 回滚和自动启动竞争。它不覆盖真机采集、安装包或真实模型质量，完整生成/导出集成仍由 #36 验收。

正式冻结前，前后端审核者需确认上述状态边界及 TurnnoteApi、Result/ErrorCode、事件、Main/Preload/mock 一致性，并留下可查记录。后续变更在同一个 PR 更新类型、通道、schema、调用方、mock、测试和契约文档；数据库结构变化必须新增编号 migration。禁止修改已经发布的迁移或保留旧接口转发层。
