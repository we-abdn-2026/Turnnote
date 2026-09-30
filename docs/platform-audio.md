# Platform Audio 接口

macOS 和 Windows 音频采集通过 `electron-audio-loopback` 插件统一处理。

## 统一接口

`apps/desktop/main/platform/audio.ts` 提供：

```typescript
interface AudioDevice {
  id: string;
  name: string;
  kind: 'microphone' | 'system';
}

interface AudioCapture {
  listDevices(): Promise<AudioDevice[]>;
  startCapture(config: CaptureConfig): Promise<CaptureSession>;
}

interface CaptureConfig {
  microphoneId: string | null;
  includeSystemAudio: boolean;
  outputPath: string;
}

interface CaptureSession {
  stop(): Promise<void>;
  onData(callback: (buffer: Buffer) => void): void;
  onError(callback: (error: Error) => void): void;
}
```

## 输出格式

- 采样率：16000 Hz
- 通道：Mono
- 位深：16-bit PCM
- 格式：WAV

麦克风和系统音频混合为单轨，由 `electron-audio-loopback` 内部处理。

## 权限

macOS：需要麦克风权限和屏幕录制权限（系统音频）

Windows：需要麦克风权限

权限检查在 `startCapture` 前完成，拒绝时返回 `PERMISSION_DENIED` 错误。

## 错误处理

| 错误 | 说明 |
|---|---|
| `PERMISSION_DENIED` | 用户拒绝音频或屏幕录制权限 |
| `DEVICE_NOT_FOUND` | 指定设备不存在 |
| `CAPTURE_FAILED` | 采集启动失败 |
| `WRITE_FAILED` | 写入音频文件失败 |

## 实现方案

使用 Web Audio API 在 Renderer 处理音频流：
- `AudioContext` 混合多轨并重采样到 16kHz
- `ScriptProcessorNode` 或 `AudioWorkletNode` 提取 PCM 数据
- 通过 IPC 发送到 Main Process 写入 WAV

参考实现：[electron-audio-loopback](https://github.com/alectrocute/electron-audio-loopback)、[mic-speaker-streamer](https://github.com/alectrocute/mic-speaker-streamer)

## 降级方案

系统音频权限被拒时，只录制麦克风。

采集完全失败时，允许导入外部音频文件（`.wav`, `.mp3`, `.m4a`），Main Process 用 `fluent-ffmpeg` 转换为 16kHz mono WAV。

## 测试隔离

测试时通过依赖注入 mock `AudioCapture` 接口，不依赖真实音频设备。

CI 不运行需要音频设备的集成测试。
