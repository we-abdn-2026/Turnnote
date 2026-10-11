# Python Sidecar 协议

Node.js Main Process 与 Python ASR Worker 通过 stdin/stdout 的 JSON Lines 通信。

## 生命周期

1. Main Process 按任务启动 sidecar
   - 开发：`python3 services/asr-worker/worker.py`（使用 `.venv`）
   - 安装包：`resources/asr-worker/asr-worker[.exe]`（PyInstaller 产物）
2. 启动后发送 `ping`，10 秒内收到 `pong` 视为就绪
3. 发送 `transcribe` 请求
4. Sidecar 流式返回 `progress` 和 `segment` 事件，最后返回 `done`
5. Main Process 发送 `shutdown` 或关闭 stdin，sidecar 退出

Sidecar 每任务单次启动，不常驻。

Main 使用 processing_jobs 的唯一 ID 关联 transcribe 请求和响应，进度转发时携带 jobId。取消或重试后，旧 job 的 segment/done/error 不提交、不转发进度；数据库通过 isJobCurrent 及完成方法二次校验。Sidecar 的 INVALID_JSON/INVALID_REQUEST/UNKNOWN_REQUEST 属于协议问题，由 Main 映射为 SIDECAR_PROTOCOL_ERROR，不将不受控 message 直接展示。见 [W1 IPC 契约基线](ipc-contract.md)。

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
  "modelPath":"/absolute/path/to/models/small"
}
```

- `audioPath`：应用管理目录内的绝对路径，支持 `.wav`、`.mp3`、`.m4a`
- `language`：`"en"` | `"zh"` | `"auto"`
- `modelPath`：已下载的 faster-whisper 模型目录

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
| `AUDIO_DECODE_FAILED` | 扩展名不在 `.wav`/`.mp3`/`.m4a` 内，或音频无法解码、无采样 |
| `MODEL_LOAD_FAILED` | `modelPath` 不是目录、模型加载失败或 faster-whisper 未安装 |
| `TRANSCRIBE_FAILED` | 转写过程失败 |
| `NOT_IMPLEMENTED` | 功能未实现（脚手架阶段） |

## 超时和取消

| 场景 | 处理 |
|---|---|
| 10 秒内无 `pong` | 杀进程，记录 `SIDECAR_START_FAILED` |
| 转写中 120 秒无任何输出 | 杀进程，记录 `SIDECAR_TIMEOUT` |
| 进程意外退出 | 记录 `SIDECAR_CRASHED`；stderr 仅用于内部诊断，不透传或持久化原文 |
| stdout 出现非 JSON 行 | 记录 `SIDECAR_PROTOCOL_ERROR`，杀进程 |
| 用户取消 | 直接杀进程，不发送取消消息 |

以上错误码由 Main 生成，不由 sidecar 返回。所有失败都保留音频，允许重试。

转写片段在收到 `done` 后一次性写入数据库；失败时不写入部分片段。

## Fake 模式

`worker.py --fake` 不加载模型，对合法的 `transcribe` 请求返回固定的 3 个片段，仍执行参数校验和音频文件存在检查。

用于 CI 和没有下载模型的开发环境。Main 在环境变量 `TURNNOTE_ASR_FAKE=1` 时带 `--fake` 启动 sidecar。

## 诊断日志

Sidecar 将诊断信息写入 stderr，Main Process 捕获并记录。

stdout 只输出 JSON Lines 响应。启动时 sidecar 把 fd 1 重定向到 stderr、协议输出走复制出的描述符，原生库直接写 stdout 的内容也会进入 stderr。

## 转写行为

- 音频由 PyAV 解码为 16kHz 单声道后送入 faster-whisper（CPU、int8），开启 VAD 过滤静音。
- `startMs`/`endMs` 为整数毫秒，截断到 `durationMs` 以内；`durationMs` 为解码后音频时长。
- 空文本片段不输出；`segmentCount` 等于实际输出的 `segment` 数。
- 每个 `segment` 后发送一次 `progress`（按片段结束时间占总时长计算，最高 99），`done` 前发送 100。

## 模型存储

模型存储在 `userData/models/<model>/`。首次使用时 Main Process 下载并校验。

Sidecar 只读取 `modelPath`，不访问网络。
