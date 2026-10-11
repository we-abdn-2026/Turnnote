# Platform Audio 接口

系统音频使用 [`electron-audio-loopback`](https://github.com/alectrocute/electron-audio-loopback)，底层由 Chromium 调用 macOS ScreenCaptureKit / Core Audio 和 Windows WASAPI Loopback。麦克风使用 `getUserMedia`。

## 进程职责

| 进程 | 职责 |
|---|---|
| Main | 启动前调用 `initMain()` 并加固 loopback IPC；接收 PCM 分块写入 WAV；管理文件路径 |
| Preload | 暴露 `turnnote.loopback.enable/disable` 和 `turnnote.recording.*`（见 `packages/contracts`） |
| Renderer | 获取麦克风和系统音频 MediaStream；混音、重采样、转 PCM16；分块发送给 Main |

Renderer 不接触文件路径，只提交 `meetingId` 和 PCM 数据。

## 采集流程

1. `turnnote.recording.start(meetingId)`，Main 创建 `AudioWriter`
2. `turnnote.loopback.enable()`，然后 `getDisplayMedia({ video: true, audio: true })`，立即停止并移除视频轨
3. `turnnote.loopback.disable()`
4. `getUserMedia({ audio: { deviceId } })` 获取麦克风
5. 优先 `new AudioContext({ sampleRate: 16000 })`，设备不支持时使用原生采样率；两路 `MediaStreamAudioSourceNode` 接入同一个 `AudioWorkletNode`，流式重采样保证输出始终为 16kHz
6. 保存 start 返回的 activeJobId；Worklet 混为单声道、转 Int16，每约 1 秒调用一次 `turnnote.recording.appendChunk(meetingId, jobId, chunk)`
7. 停止时关闭所有轨道和 `AudioContext`，调用 `turnnote.recording.stop`，Main 完成写入并开始转写

stop(meetingId, jobId) 固定返回 captured 快照，后续自动转写通过 meetingUpdated 事件报告。采集失败后 Renderer 关闭轨道并调用 recording.fail(meetingId, jobId, code)，Main 使用安全错误目录并保留可恢复音频。用户显式取消调用 recording.cancel(meetingId, jobId)，文件清理成功后才回到 created；清理失败不丢失引用。完整状态边界见 [W1 IPC 契约基线](ipc-contract.md)。录音与自动转写通过 createSessionServices 接入；captured 提交后先登记自动转写，再发布 captured 事件。手动启动、取消、删除和退出会使待启动任务失效；真实模型引擎仍由 #8 验收。

## 接口

```typescript
// Renderer: apps/desktop/renderer/audio/capture.ts
interface CaptureOptions {
  meetingId: string;
  microphoneDeviceId: string | null; // null 表示不录麦克风
  includeSystemAudio: boolean;
}

interface CaptureSession {
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

function startCapture(options: CaptureOptions): Promise<CaptureSession>;
```

```typescript
// Main: apps/desktop/main/platform/audio-writer.ts
interface AudioWriter {
  append(chunk: Int16Array): void;
  finalize(): Promise<void>; // 回写 WAV header 中的数据长度
}

function createAudioWriter(outputPath: string): AudioWriter;
function repairWavHeader(path: string): Promise<boolean>; // 崩溃恢复用
```

## 输出格式

16000 Hz、单声道、16-bit PCM、WAV。

## 权限

| 平台 | 需要 |
|---|---|
| macOS | 麦克风权限；屏幕录制权限（系统音频）；`Info.plist` 声明 `NSMicrophoneUsageDescription`、`NSAudioCaptureUsageDescription` |
| Windows | 麦克风权限 |

macOS 权限状态用 `systemPreferences.getMediaAccessStatus('microphone' | 'screen')` 检查，被拒时引导用户打开系统设置。`NSAudioCaptureUsageDescription` 在不同 macOS 版本上的实际要求需真机确认。

## 错误码

| 错误码 | 含义 |
|---|---|
| `PERMISSION_DENIED` | 麦克风或屏幕录制权限被拒 |
| `DEVICE_NOT_FOUND` | 指定麦克风不存在 |
| `CAPTURE_FAILED` | 获取 MediaStream 或启动 AudioContext 失败 |
| `WRITE_FAILED` | 写入 WAV 失败（含磁盘空间不足） |

## 降级

- 系统音频不可用：只录麦克风，界面提示
- 采集完全不可用：导入本地音频文件（`.wav`、`.mp3`、`.m4a`），复制到应用管理目录后直接交给 sidecar，由 faster-whisper 解码

## 测试

- `AudioWriter` 和 `repairWavHeader`：Node 单元测试，覆盖 header 正确性和截断文件修复
- 真实采集：只做 macOS / Windows 真机手动测试，CI 不运行

## 实现与验证边界（#5 / #6）

- 依赖锁定为 electron-audio-loopback 1.0.6。保留其 initMain 平台初始化，以应用主 frame 校验替换库的固定 IPC handler；桌面源获取失败以空回调拒绝，避免库中未处理异常。Electron 44 的实际兼容性以真机记录为准。
- Worklet 对各输入通道下混，再对活动来源等权混音；原生采样率通过连续面积平均窗口转换到 16kHz，跨 render quantum 保留小数状态。每秒发送一块；stop 的 flush 确认之后等待 IPC 队列，再 finalize。输出连接为静音，避免录音监听形成反馈。
- IPC 写入队列最多积压八块，超过后报告 WRITE_FAILED 并保留已写数据。Main 串行处理录音调用，会议及 jobId 双重校验拒绝迟到请求。
- WAV 独占创建，按小端编码，停止时根据实际文件长度回写 header；修复只接受应用的固定 PCM WAV 格式，丢弃最后半个样本，不改写未知格式。启动后修复未结束的录音并标记 INTERRUPTED，不自动转写。
- Renderer 关闭、崩溃或应用退出时结束 Main writer。删除会议前先释放 writer；文件删除失败保留数据库引用。
- 工作区持有当前会议的唯一采集会话，每次启动读取已保存的麦克风/系统音频设置；dev:web 使用显式 mock adapter。参会者告知确认、停止保存及失败录音丢弃均通过工作区操作。
- 文件 finalize 与数据库终态提交分开协调：关闭文件后仍保留 job 归属，数据库 stop/fail/shutdown 事务失败可以再次提交；只有终态提交成功或显式删除释放后才移除归属。迟到 PCM 不得写入已 finalize 的文件。
- Renderer 只 flush/关闭媒体一次；Main 保存提交失败后 stop 重试只重发提交，不重新采集、不删除 WAV。媒体已关闭时界面显示“录音已结束，等待保存”并提供“重试保存”，不把尚未提交的业务状态解释为仍在采集。
- cancel 仅合并正在进行的请求，失败后可显式重试；已成功丢弃后重复调用不再发送 IPC。媒体清理始终幂等。
- 初始 WAV header 写入失败时尝试关闭并删除本次独占创建的文件；删除本身失败仍返回安全 WRITE_FAILED，可能遗留无音频内容的文件，不宣称清理成功。
- 自动测试中的 MediaStream、AudioContext 和 IPC 替身只验证流程，不作为真实平台采集证据。实际验证记录见 [audio-validation.md](audio-validation.md)。
