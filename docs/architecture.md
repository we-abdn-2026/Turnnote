# Turnnote 系统架构图

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron Renderer                                            │
│ React + TypeScript                                           │
│ 会议工作区 · 录音控制 · 转写查看 · 纪要编辑 · 导出               │
└──────────────────────────────┬───────────────────────────────┘
                               │ 类型化 Preload IPC
┌──────────────────────────────▼───────────────────────────────┐
│ Electron Main Process                                        │
│ Node.js + TypeScript                                         │
│ 会话编排 · 文件管理 · SQLite · DeepSeek · sidecar 生命周期管理   │
└──────────────┬───────────────────────┬───────────────────────┘
               │ JSON Lines             │ HTTPS
               ▼                       ▼
┌──────────────────────────┐  ┌───────────────────────────────┐
│ Python ASR Sidecar       │  │ DeepSeek API                   │
│ faster-whisper           │  │ 转写文本 -> 结构化会议纪要       │
└──────────────┬───────────┘  └───────────────────────────────┘
               │
               ▼
┌──────────────────────────┐
│ Local Storage             │
│ SQLite + managed files   │
└──────────────────────────┘

Platform adapters, coordinated by Electron Main:
  macOS: ScreenCaptureKit + microphone input
  Windows: WASAPI Loopback + microphone input
```

## 图例

- **Renderer**：用户界面和交互。
- **Preload IPC**：Renderer 与 Main 之间的受控通信边界。
- **Main Process**：本地业务编排、文件、数据库、凭证和网络请求。
- **Python ASR Sidecar**：本地语音转写进程，仅通过 JSON Lines 通信。
- **DeepSeek API**：接收用户显式提交的转写文本并生成结构化纪要。
- **Local Storage**：SQLite 与应用管理的本地文件。
- **Platform adapters**：macOS 和 Windows 的系统音频采集适配层。
