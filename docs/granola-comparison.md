# Granola 功能对比

Granola 是 Turnnote 对标的商业产品，核心定位是 **"AI notepad for meetings"**。

## Granola 核心功能

### 1. Botless 本地录音
- 桌面应用，不在参与者列表中出现
- 捕获麦克风 + 系统音频
- 支持所有会议平台（Zoom、Teams、Google Meet、现场会议）
- 音频立即删除，不保留录音

### 2. Human-in-the-loop 笔记
- 用户边开会边打关键词和简短笔记（如 "pricing concerns"）
- AI 找到所有相关讨论并扩展上下文
- 粗笔记引导 AI 生成，而不是完全自动

### 3. 结构化纪要
- 摘要、关键主题、决策、行动项
- 用户粗笔记决定 AI 关注什么

### 4. 跨会议搜索
- 文件夹级查询
- "Chat with your meetings" 功能

### 5. 集成和分享
- HubSpot CRM 集成
- 分享链接、API、MCP 连接器

来源：[Granola Blog](https://www.granola.ai/blog/)、[aidemos.com](https://aidemos.com/tools/granola)、[meetergo.com](https://meetergo.com/en/magazine/granola-ai)

## Turnnote MVP 对比

| 功能 | Granola | Turnnote MVP | 状态 |
|---|---|---|---|
| Botless 本地录音 | ✅ | ✅ | 已规划 |
| 音频即删 | ✅ | ✅ | 已规划 |
| 结构化纪要 | ✅ | ✅ | 已规划 |
| 可编辑和导出 | ✅ | ✅ Markdown | 已规划 |
| 实时人工粗笔记 | ✅ 核心功能 | ❌ | 超出 MVP |
| 关键词引导生成 | ✅ | ✅ 会后标注 | **Week 2 新增** |
| 转写片段跳转 | ✅ | ✅ | **Week 3 新增** |
| 跨会议搜索 | ✅ | ❌ | 超出 MVP |
| CRM 集成 | ✅ HubSpot | ❌ | 超出 MVP |
| 分享和协作 | ✅ | ❌ | 超出 MVP |

## Turnnote 差异化

### 保留的核心价值
1. ✅ 本地优先，隐私透明
2. ✅ 音频即删
3. ✅ 结构化纪要
4. ✅ 可编辑导出

### 借鉴 Granola 的增强
1. **关键词引导生成**（Week 2）
   - 转写完成后用户标注关键词
   - 重新生成时 DeepSeek prompt 包含关键词，优先扩展相关片段
   - 不做实时协同笔记，保持 MVP 简单

2. **转写片段跳转**（Week 3）
   - 纪要中决策和行动项标注来源时间戳
   - 点击跳转到对应转写片段
   - 提升可验证性和可信度

### 明确不做（超出 MVP）
- 实时协同笔记
- 自动会议检测
- 跨会议搜索和 Chat
- CRM 集成
- 分享链接和云同步

## 实现优先级

**必须**：
1. Botless 录音 + 音频即删
2. 转写 + 结构化纪要
3. 编辑和导出

**增强**（不破坏工期）：
1. 关键词引导（2 天）
2. 转写跳转（1 天）

**延后**：
- 跨会议搜索
- 集成和协作
