# Python Sidecar 协议

Node.js Main Process 与 Python ASR Worker 通过 stdin/stdout 的 JSON Lines 通信。

## 生命周期

1. Main Process 按任务启动 sidecar：`spawn('python3', ['services/asr-worker/worker.py'])`
2. 启动后发送 `ping`，10 秒内收到 `pong` 视为就绪
3. 发送 `transcribe` 请求
4. Sidecar 流式返回 `progress` 和 `segment` 事件，最后返回 `done`
5. Main Process 发送 `shutdown` 或关闭 stdin，sidecar 退出

Sidecar 每任务单次启动，不常驻。

## 请求格式

每行一个 JSON 对象，以 `\n` 结束。

### ping

```json
{"id":"req-1","type":"ping"}
```

### transcribe

```json
{
  "id":"req-2",
  "type":"transcribe",
  "audioPath":"/absolute/path/to/audio.wav",
  "language":"en",
  "model":"base"
}
```

- `language`: `"en"` | `"zh"` | `"auto"`
- `model`: faster-whisper 模型名，如 `"base"`, `"small"`, `"medium"`

### shutdown

```json
{"id":"req-3","type":"shutdown"}
```

## 响应格式

### pong

```json
{"id":"req-1","type":"pong","status":"ok"}
```

### progress

```json
{"id":"req-2","type":"progress","percent":35}
```

`percent`: 0-100 整数。

### segment

```json
{
  "id":"req-2",
  "type":"segment",
  "startMs":1200,
  "endMs":3800,
  "text":"Meeting agenda for today."
}
```

### done

```json
{
  "id":"req-2",
  "type":"done",
  "detectedLanguage":"en",
  "durationMs":125000,
  "segmentCount":48
}
```

### error

```json
{
  "id":"req-2",
  "type":"error",
  "code":"AUDIO_NOT_FOUND",
  "message":"Audio file does not exist at the specified path."
}
```

## 错误码

| 错误码 | 含义 |
|---|---|
| `INVALID_JSON` | 请求不是合法 JSON |
| `INVALID_REQUEST` | 缺少必需字段 |
| `UNKNOWN_REQUEST` | 不支持的 `type` |
| `AUDIO_NOT_FOUND` | 音频文件不存在 |
| `AUDIO_DECODE_FAILED` | 音频格式无效 |
| `MODEL_LOAD_FAILED` | 模型加载失败 |
| `TRANSCRIBE_FAILED` | 转写过程失败 |
| `NOT_IMPLEMENTED` | 功能未实现（脚手架阶段） |

## 超时和取消

Main Process 启动 120 秒无响应超时，直接 `SIGTERM` 杀死进程，记录 `SIDECAR_TIMEOUT`。

用户取消时直接杀进程，不发送取消消息。

## 诊断日志

Sidecar 将诊断信息写入 stderr，Main Process 捕获并记录。

stdout 只输出 JSON Lines 响应。

## 模型存储

模型存储在 `userData/models/`，路径由 Main Process 管理。

首次运行时 Main Process 从 Hugging Face 下载模型并校验 SHA256。

Sidecar 接收完整模型路径，不自行下载。
