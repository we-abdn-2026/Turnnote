# 安全诊断日志

Turnnote 的 Main、IPC、ASR sidecar 和 DeepSeek 客户端共用结构化安全日志策略。日志用于定位
错误发生在哪一层，不记录请求或会议内容。

## 日志位置

开发运行和安装包运行都写入 Electron `userData` 目录下的 `logs/turnnote.log`：

- macOS：`~/Library/Application Support/Turnnote/logs/turnnote.log`
- Windows：`%APPDATA%\\Turnnote\\logs\\turnnote.log`

实际目录名称可能随应用名称或开发环境变化，应以 Electron 的 `userData` 路径为准。日志采用
JSON Lines，每条一行；当前文件达到 1 MB 后轮换为 `turnnote.log.1`，只保留一份旧日志。
目录和文件在支持 POSIX 权限的平台分别限制为 `0700` 和 `0600`。

## 可以分享的字段

- `timestamp`、`level`
- `source`：`main`、`ipc`、`sidecar` 或 `deepseek`
- 固定的 `event` 和错误 `code`
- 已知 IPC `operation`
- 白名单异常类别 `exceptionType`
- sidecar 白名单阶段 `diagnosticStage`

## 隐私边界

不要写入或分享 API Key、Authorization header、IPC 参数、异常 message/stack、完整本地路径、
sidecar 原始 stderr、转写片段或纪要正文。调用方可以把原始异常交给 `SafeLogger.error`，日志器
只提取白名单异常类别；sidecar 原始 stderr 只能交给 `sidecarFailure`，它只保留已知处理阶段。
DeepSeek 客户端接入时使用 `source: deepseek` 和共享错误码，不记录请求、响应或凭证。

日志本身仍会暴露错误发生时间、功能来源和错误码。对外提交日志前应再次检查内容，并只附上
复现问题所需的行。
