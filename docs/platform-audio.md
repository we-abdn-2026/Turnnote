# Platform Audio 接口

系统音频使用 [`electron-audio-loopback`](https://github.com/alectrocute/electron-audio-loopback)，底层由 Chromium 调用 macOS ScreenCaptureKit / Core Audio 和 Windows WASAPI Loopback。麦克风使用 `getUserMedia`。

## 进程职责

| 进程 | 职责 |
|---|---|
| Main | 启动前调用 `initMain()`；接收 PCM 分块写入 WAV；管理文件路径 |
| Preload | 暴露 `turnnote.loopback.enable/disable` 和 `turnnote.recording.*`（见 `packages/contracts`） |
| Renderer | 获取麦克风和系统音频 MediaStream；混音、重采样、转 PCM16；分块发送给 Main |

Renderer 不接触文件路径，只提交 `meetingId` 和 PCM 数据。

## 采集流程

1. `turnnote.recording.start(meetingId)`，Main 创建 `AudioWriter`
2. `turnnote.loopback.enable()`，然后 `getDisplayMedia({ video: true, audio: true })`，立即停止并移除视频轨
3. `turnnote.loopback.disable()`
4. `getUserMedia({ audio: { deviceId } })` 获取麦克风
5. `new AudioContext({ sampleRate: 16000 })`，两路 `MediaStreamAudioSourceNode` 接入同一个 `AudioWorkletNode`
6. Worklet 混为单声道、转 Int16，每约 1 秒调用一次 `turnnote.recording.appendChunk`
7. 停止时关闭所有轨道和 `AudioContext`，调用 `turnnote.recording.stop`，Main 完成写入并开始转写

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
