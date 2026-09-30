# Turnnote 技术方案

## 1. 方案概述

Turnnote 是面向 macOS 和 Windows 的本地优先桌面会议助手。系统将会议音频采集、本地语音转写、结构化纪要生成、人工校对和 Markdown 导出组织为连续工作流。

```text
音频采集 -> 本地转写 -> 本地保存转写 -> 用户请求纪要 -> DeepSeek 生成 -> 用户校对 -> 导出
```

原始音频由本地应用处理，不发送给 DeepSeek。DeepSeek 只处理用户显式提交的转写文本和生成纪要所需的上下文。

## 2. 技术选型

| 技术层 | 选型 | 责任范围 |
| --- | --- | --- |
| 桌面容器 | Electron | 应用生命周期、窗口、进程管理和跨平台打包 |
| 界面层 | React + TypeScript | 会议工作区、状态展示、纪要编辑和设置 |
| 本地业务层 | Node.js + TypeScript | 会话编排、IPC、文件、数据库、DeepSeek 请求和进程管理 |
| 本地数据库 | SQLite | 会议元数据、转写片段、纪要版本和任务状态 |
| 语音识别 | Python + faster-whisper | 在用户设备上将音频转为带时间戳文本 |
| 进程通信 | JSON Lines over stdin/stdout | Node.js 主进程与 Python 转写进程的结构化通信 |
| 远程语言模型 | DeepSeek API | 根据转写文本生成结构化会议纪要 |
| macOS 音频 | ScreenCaptureKit | 系统音频采集与相关权限处理 |
| Windows 音频 | WASAPI Loopback | 系统音频采集与相关权限处理 |

Python 进程只负责语音转写，不访问 SQLite、DeepSeek 或用户凭证。Node.js Electron Main Process 是本地业务状态和副作用的唯一所有者。

## 3. 运行时职责

### 3.1 Renderer

Renderer 负责音频源选择、录音控制、处理状态、时间戳转写查看、纪要编辑、Markdown 导出和数据处理提示。Renderer 不得直接访问文件系统、SQLite、环境变量、API Key 或外部网络，所有请求通过 Preload 暴露的类型化 IPC 接口完成。

### 3.2 Preload 与 IPC

Preload 是 Renderer 到 Main 的唯一桥接层。接口按业务能力定义并采用白名单注册，输入在 Main Process 中再次校验。

Electron 窗口必须启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。IPC 响应不得返回 API Key 或其他凭证原文。

### 3.3 Main Process

Main Process 负责会议会话、临时音频、平台适配器、Python sidecar 生命周期、SQLite、DeepSeek 请求、系统安全凭证存储、Markdown 导出及安全日志。

### 3.4 Python ASR Sidecar

Sidecar 由 Main Process 按任务启动，通过标准输入接收 JSON Lines 请求，通过标准输出返回 JSON Lines 响应；诊断信息写入标准错误。成功响应包含任务 ID 与转写片段；失败响应包含任务 ID、稳定错误码和可展示信息。Main Process 处理启动失败、意外退出、无效 JSON、超时和重复响应。

### 3.5 平台音频适配器

系统音频通过 `electron-audio-loopback` 获取，底层由 Chromium 调用 macOS ScreenCaptureKit / Core Audio 和 Windows WASAPI Loopback。Renderer 负责混音和重采样，Main Process 负责写入 WAV 和权限检查。详见 [Platform Audio 接口](platform-audio.md)。

- macOS 需要麦克风和屏幕录制权限。
- Windows 需要麦克风权限。

## 4. 数据与状态

| 实体 | 作用 |
| --- | --- |
| `Meeting` | 会议标题、状态和时间信息 |
| `AudioAsset` | 应用管理的临时或保留音频引用 |
| `TranscriptSegment` | 起止时间和转写文本 |
| `MeetingNote` | 结构化纪要及用户编辑版本 |
| `ProcessingJob` | 转写和纪要生成任务状态与错误 |
| `AppSetting` | 非敏感应用设置 |

API Key 不存储在 SQLite 或普通配置文件中，使用操作系统安全凭证存储。会议状态至少包括 `created`、`recording`、`captured`、`transcribing`、`transcribed`、`generating`、`ready`、`failed` 和 `deleted`。外部服务失败时，已保存的会议、转写和用户编辑内容必须保留。

音频默认在成功转写后删除，用户可以按会议选择保留。删除会议时，应用管理范围内的数据库记录和保留音频一并删除；本地删除不等同于外部服务数据删除。

## 5. DeepSeek 纪要生成

纪要生成由用户显式触发。发送前界面说明将向 DeepSeek 发送转写文本及必要上下文，原始音频不进入请求。

纪要结构固定为 `summary`、`keyTopics`、`decisions`、`openQuestions` 和 `actionItems`。负责人和截止日期只有在转写中明确出现时才填写，否则标记为 `unspecified`。模型响应必须先通过 JSON/schema 校验，再写入本地纪要；转写回看和用户编辑是结果确认环节。

长会议通过有上限的分段和中间摘要合并处理。超时、限流、上下文超限、无效 JSON 和供应商错误不得导致本地转写或用户编辑丢失。

## 6. 安全与隐私

- 录音开始前显示参会者授权提醒，采集过程中持续显示录音状态。
- Renderer 不接触 API Key、文件系统和任意网络能力。
- API Key 不写入日志、SQLite 或普通设置导出。
- 用户输入的文件路径经过规范化，只能访问应用管理目录。
- 日志不输出凭证、完整音频路径、完整转写和完整纪要正文。
- 删除、保留和导出操作由用户显式触发。
- 数据说明区分本地存储、发送给 DeepSeek 的文本和外部服务处理边界。

## 7. 可靠性与降级策略

| 风险 | 触发条件 | 处理策略 |
| --- | --- | --- |
| 系统音频采集不可用 | 某平台无法稳定提供系统音频 | 降级为麦克风录音或音频文件导入 |
| Python sidecar 无法启动 | 运行时、模型或依赖加载失败 | 保留音频并提供重试，不删除唯一音频副本 |
| 本地转写性能不足 | 处理时延或测试质量未达到基线 | 使用更小模型、异步处理或允许导入转写文本 |
| DeepSeek 不可用 | 网络超时、限流或服务错误 | 保留转写和编辑内容，延迟重试 |
| 长文本超过模型上下文 | 单次请求超出限制 | 分段生成中间摘要后合并 |
| 进度超过排期 | 关键技术验证未通过 | 移除实时字幕、说话人分离、协作和外部集成 |

## 8. 验证范围

工程验证覆盖平台权限和采集、sidecar 生命周期、中文和英文转写、长音频、DeepSeek 失败恢复、数据删除、Markdown 导出、IPC 安全配置和 API Key 隔离。
