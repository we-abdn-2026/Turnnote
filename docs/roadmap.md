# 开发路线图

开发周期：2026-09-30 至 2026-10-30（4 周）

## 里程碑

| 阶段 | 截止日期 | 交付物 |
|---|---|---|
| Week 1 | 10-06 | 数据库、sidecar 转写、音频采集基础 |
| Week 2 | 10-13 | 完整录音到转写流程、DeepSeek 集成 |
| Week 3 | 10-20 | 会议管理、编辑、导出、跨平台测试 |
| Week 4 | 10-27 | 集成测试、打包、文档、pilot 准备 |
| Release | 10-30 | 发布 MVP |

## 后端任务

### Week 1
- [ ] 实现 `storage/` 数据库层（schema、migrations、CRUD）
- [ ] 集成 `electron-audio-loopback`，实现 Renderer 音频采集（麦克风 + 系统音频混音、16kHz 重采样）
- [ ] 实现 Main Process `AudioWriter`（IPC 接收 PCM 分块、写入 WAV、header 修复）
- [ ] 实现 sidecar 生命周期管理（spawn、健康检查、重启）
- [ ] 实现 Python sidecar `transcribe` 请求处理和 faster-whisper 集成

**验收**：录制 30 秒音频保存为 WAV，sidecar 返回带时间戳的转写片段，存入数据库。

### Week 2
- [ ] 实现 DeepSeek API 客户端（`services/deepseek.ts`）
- [ ] 实现 prompt 模板和结构化输出 schema 校验
- [ ] 实现长文本分段和中间摘要合并
- [ ] 实现 API 重试、限流、超时处理
- [ ] 实现系统凭证存储 API Key（Electron `safeStorage`）
- [ ] **实现关键词引导生成**：用户标注关键词，重新生成时 prompt 包含关键词优先扩展相关片段

**验收**：转写完成后生成结构化纪要，包含 summary、decisions、actionItems，存入 `note_versions`。标注"定价"关键词后重新生成，纪要优先扩展定价相关讨论。

### Week 3
- [ ] 实现会议列表查询、搜索、重命名、删除
- [ ] 实现音频保留/删除逻辑和崩溃恢复
- [ ] 实现 Markdown 导出（包含标题、时间、纪要内容）
- [ ] 实现纪要编辑版本管理和持久化
- [ ] **实现转写片段高亮跳转**：纪要中每个决策/行动项标注来源时间戳，点击跳转到对应转写片段

**验收**：用户可搜索会议、编辑纪要、导出 Markdown、删除会议并清理关联文件。点击纪要中的决策可跳转到对应转写时间。

### Week 4
- [ ] 实现安全日志（过滤凭证和敏感路径）
- [ ] 实现错误码和用户可见错误消息映射
- [ ] 完成 Windows 和 macOS 真机测试
- [ ] 修复跨平台兼容问题

**验收**：macOS 13+ 和 Windows 10 22H2+ 上完成端到端录音、转写、生成、编辑、导出流程。

## 前端任务

### Week 1
- [ ] 实现音频设备选择界面（麦克风、系统音频）
- [ ] 实现录音控制按钮和状态指示器
- [ ] 实现会议创建和录音状态实时更新

**验收**：用户可选择设备、开始/停止录音，界面显示录音中状态。

### Week 2
- [ ] 实现转写片段列表展示（时间戳 + 文本）
- [ ] 实现处理状态界面（transcribing、generating 进度）
- [ ] 实现纪要结构化展示（summary、decisions、actionItems）
- [ ] 实现 DeepSeek 数据发送提示和确认
- [ ] **实现关键词标注 UI**：转写完成后可输入关键词（如"定价讨论"），点击"重新生成"时传递给后端

**验收**：用户可查看转写和生成的纪要，明确知道哪些数据发送给 DeepSeek。可标注关键词并重新生成纪要。

### Week 3
- [ ] 实现会议列表和搜索
- [ ] 实现纪要编辑器（支持修改 summary、decisions、actionItems）
- [ ] 实现设置界面（模型选择、语言、API Key 输入）
- [ ] 实现导出按钮和文件保存对话框
- [ ] **实现转写片段时间戳跳转**：纪要中的决策/行动项可点击跳转到对应转写位置

**验收**：用户可编辑纪要并保存，设置 API Key 后可使用 DeepSeek 功能。点击纪要中的内容可跳转到转写对应位置。

### Week 4
- [ ] 实现错误提示和重试按钮
- [ ] 实现音频保留选项和删除确认对话框
- [ ] 优化布局和视觉一致性
- [ ] 完成用户录屏和操作视频

**验收**：错误场景有清晰提示和恢复选项，界面在两平台一致。

## 测试任务

### Week 1-2
- [ ] 编写 sidecar 协议单元测试（ping、transcribe、错误响应）
- [ ] 编写数据库 CRUD 和状态机单元测试
- [ ] 编写 `AudioWriter` 和 WAV header 修复单元测试

**验收**：`npm run test` 通过，覆盖协议、数据库、状态转换。

### Week 3
- [ ] 编写 DeepSeek 集成测试（mock API 响应）
- [ ] 编写端到端集成测试（录音 → 转写 → 生成 → 导出）
- [ ] 编写崩溃恢复测试（中断录音、转写、生成）

**验收**：集成测试覆盖正常和失败路径，崩溃恢复测试验证数据保留。

### Week 4
- [ ] 真机测试矩阵（macOS 13/14, Windows 10/11, x64/arm64）
- [ ] 测试长会议（1 小时音频）性能和内存
- [ ] 测试中英文转写质量基线
- [ ] 记录已知问题和 workaround

**验收**：测试矩阵通过，性能和质量基线文档化。

## 部署任务

### Week 3
- [ ] 配置 `electron-builder` 打包（macOS DMG、Windows NSIS installer）
- [ ] 配置 PyInstaller 打包 Python sidecar（onedir 模式）
- [ ] 配置 `extraResources` 打包 sidecar 可执行文件

**验收**：本地可生成 macOS 和 Windows 安装包。

### Week 4
- [ ] macOS 安装包测试（x64 和 arm64）
- [ ] Windows 安装包测试（x64）

**验收**：安装包可在 macOS 13+ 和 Windows 10 22H2+ 安装并运行。

## 外部依赖

| 依赖 | 状态 |
|---|---|
| DeepSeek API 测试密钥 | 必需 |
| 测试设备矩阵（macOS/Windows 真机） | 必需 |

## MVP 范围外

以下功能明确排除，不在一个月工期内实现：

- 实时字幕
- 说话人分离（speaker diarization）
- 云同步和用户账号
- 日历集成和自动会议检测
- 协作和团队工作区
- Meeting bot 和自动加入会议
- 外部任务管理集成（Jira、Notion 等）
- 视频录制
