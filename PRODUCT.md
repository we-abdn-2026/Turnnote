# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron 桌面应用，macOS 与 Windows 共用同一套 React Renderer 界面；不按操作系统切换设计语言。

## Users

参加周期性线上会议的专业人士和小团队成员（来源：`proposal.md`）。他们一边参与讨论、一边想留下可靠记录，会后需要快速得到可核对的摘要、决策和行动项。首个版本只服务个人完整会议流程，不提供团队账号或协作。

Pilot 实际招募人群尚未在仓库中记录；目标人群和问题频率由 pilot 验证，不作为已证实的市场需求。

## Product Purpose

把会议采集、本地转写、AI 纪要、人工校对和 Markdown 导出连成一条桌面工作流，让用户专心开会，会后拿到可核对、可编辑的会议记录。

成功标准（pilot 评估目标，非已达成结果）：至少 80% 的 pilot 用户无需协助完成端到端流程；纪要有用度平均达到 4/5；网络和服务可用时至少 95% 的有效 DeepSeek 请求成功。

## Positioning

本地优先、处理边界可见的会议助手。原始音频只在用户设备上由 faster-whisper 转写，不发给任何外部服务；只有用户显式提交时，转写文本才发给 DeepSeek，且发送前界面会说明发送内容。纪要中的决策和行动项带有经过核对的转写来源时间，用户可以回到原文检查 AI 输出。同类产品类别参考 Granola。

## Operating Context

- 典型流程：创建会议 → 选择麦克风和系统音频 → 提醒取得参会者同意 → 开始/停止录音 → 后台本地转写 → 查看时间戳转写 → 用户确认后请求 DeepSeek 生成纪要 → 对照转写校对和编辑 → 导出 Markdown。
- 也可以导入音频文件代替录音。
- 用户在会议进行中只需要看清录音状态；大部分阅读和编辑发生在会后。
- 转写和纪要生成是后台任务，可能持续较久；录音、转写、生成三个状态必须能区分。
- 导出的 Markdown 进入用户现有的文档流程，不依赖同步服务。

## Capabilities and Constraints

- 会议状态：`created`、`recording`、`captured`、`transcribing`、`transcribed`、`generating`、`ready`、`failed`、`deleted`。
- 纪要结构固定为摘要、关键主题、决策、未决问题、行动项。负责人和截止日期只在转写明确出现时填写，否则显示为未指定。
- 关键词是用户关注点，用于引导生成，不是会议事实；转写没提到的关键词不会出现在纪要中。
- 长会议分段生成中间纪要再合并；超时、限流、上下文超限、无效 JSON 和供应商错误都不能丢失本地转写或用户编辑。
- 纪要编辑使用乐观锁版本；冲突时不覆盖。
- 音频默认在成功转写后删除，用户可以按会议选择保留。删除会议会删除应用管理的本地记录和保留音频；本地删除不等于外部服务端删除。
- 会议库支持搜索（标题和转写文本）、重命名和删除。设置包括音频设备、转写语言（`en` / `zh` / `auto`）和 DeepSeek API Key。
- 安全边界：Renderer 只通过 Preload 白名单 IPC 访问 Main，不接触文件系统、数据库、网络或凭据。API Key 存在系统安全凭据存储中，界面和日志不显示原文。错误信息不暴露路径、凭据或底层传输细节。
- Main 尚未实现的能力返回 `NOT_IMPLEMENTED`，界面必须显示诚实的未实现状态，不能隐藏或伪造成功。
- 平台基线：macOS 13 及以上；Windows 10 22H2 或 Windows 11。macOS 需要麦克风和屏幕录制权限，Windows 需要麦克风权限。
- MVP 不做：用户账号、团队空间、云同步、日历集成、自动识别会议、会议机器人、说话人分离、实时字幕、外部任务系统集成。
- Phase 3 已经功能冻结，此后只修缺陷，不加功能。路线图见 `docs/roadmap.md`。

## Brand Commitments

- 产品名 **Turnnote**，在任何语言的界面中都保留英文原名。
- 界面文案以中文为主（已确认）。现有组件文案均为中文；`apps/desktop/renderer/index.html` 中的 `lang="en"` 和英文标题 "Meeting workspace" 与此不一致，属于待修正项。
- 语气要求来自现有文案：直接说明状态和后果，例如“已采集的音频将被删除且无法恢复”。涉及录音同意和数据外发的提示必须明确，不能弱化。
- 仓库中没有 logo、图标或其他品牌素材。

## Evidence on Hand

- 产品范围和目标：`proposal.md`、`docs/technical-solution.md`、`docs/roadmap.md`。
- 中英文样本音频及转写和纪要 fixture：`tests/fixtures/sample-zh.wav`、`tests/fixtures/sample-en.wav`、`tests/fixtures/sample-transcript.json`、`tests/fixtures/expected-note.json`、`tests/fixtures/note-responses.json`。
- 尚无 pilot 数据、用户评价、性能基线或用户案例。不要编造用户评价、使用数据、转写准确率或处理速度。

## Product Principles

1. **用户掌控每一次采集和外发。** 录音、生成纪要、删除、保留和导出都由用户显式触发；向 DeepSeek 发送数据前必须说明发送了什么。
2. **本地数据永不因外部失败而丢失。** 任何转写、生成或网络失败都要保留已有转写和用户编辑，并给出恢复路径。
3. **AI 输出必须可以对照原文核对。** 纪要条目尽量连回转写来源；没有来源的内容不伪造来源，未提及的信息标为未指定。
4. **状态诚实。** 处理中、失败、未实现和不可用状态都如实显示，不用视觉处理掩盖。
5. **会议中少打扰，会议后好核对。** 录音时只要求状态清晰可见；阅读、比对和编辑体验服务于会后核对。

## Accessibility & Inclusion

目标标准为 WCAG 2.2 AA（已确认）。#86 的具体要求：键盘可完成全部操作；确认型交互支持取消、关闭和 Escape，取消不产生副作用；可访问名称、角色和焦点行为通过真实组件测试验证。界面需要同时适配中文和英文转写内容。
