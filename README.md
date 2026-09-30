# Turnnote

Turnnote 是一款面向 macOS 和 Windows 的本地优先 AI 会议助手。用户可以选择会议音频来源，获得本地时间戳转写，再通过 DeepSeek 生成可编辑的会议摘要、决策、未决问题和行动项，并将确认后的结果导出为 Markdown。

Turnnote 采用 Electron、React、TypeScript 和 Node.js 构建桌面应用，使用 Python `faster-whisper` 完成本地语音识别，使用 SQLite 保存本地会议数据。原始音频不发送给 DeepSeek；DeepSeek 只处理用户显式提交的转写文本。

## 文档

完整文档索引见 [docs/README.md](docs/README.md)

核心文档：
- [项目 Proposal](proposal.md)：产品目标、MVP 范围、时间线和行动计划
- [开发路线图](docs/roadmap.md)：一个月开发计划，按前端、后端、测试、部署分类
- [技术方案](docs/technical-solution.md)：技术选型、职责边界、数据、安全、降级和验证范围
- [系统架构图](docs/architecture.md)：系统组件和数据流示意图
- [工程说明](docs/development.md)：目录结构、环境要求、命令和实现约束

## 技术栈

```text
Electron + React + TypeScript + Node.js
Python faster-whisper
SQLite
DeepSeek API
ScreenCaptureKit / WASAPI Loopback
```

## 开发命令

```bash
npm install
npm run typecheck
npm run test
npm run build
```
