# 纪要生成

DeepSeek 纪要生成的 Main 侧实现，按模块对应 issue：

| 模块 | Issue | 职责 |
| --- | --- | --- |
| `services/note-prompt.ts` | #15 | prompt 模板、转写格式、模型输出解析和结构校验 |
| `services/deepseek.ts` | #17 | 单次 Chat Completions 请求、超时、取消、HTTP 错误映射 |
| `services/note-pipeline.ts` | #18、#20 | 长转写分段、中间纪要合并、关键词上下文、来源时间校验 |
| `services/generation.ts` | #17 | `notes.generate` 编排：任务状态、进度事件、一次提交 |

结构唯一来源是 `packages/contracts` 的 `MeetingNote` 和 `meetingNoteSchema`，各模块不另建 schema。

## 流程

1. 用户调用 `notes.generate`。Main 先检查状态和转写（`canStartJob`），再读取 API Key，缺少时返回 `API_KEY_MISSING`，不创建任务、不发请求。
2. `beginGeneration` 记录 `base_note_version`，会议进入 `generating`，返回快照，后台开始生成。
3. 只发送已保存的转写片段和 `meeting.keywords`，不读取音频文件。
4. 每个请求的输出经 `parseNoteResponse` 校验和来源时间核对。
5. 全部成功后 `completeGeneration` 在一个事务中新增 `generated` 版本、完成任务、会议进入 `ready`。
6. 任一步失败：`failJob` 只记录错误码，转写、音频引用和已有纪要版本不变，用户可重试。重试和重新生成都会新增版本，不覆盖旧版本。

生成期间用户保存了编辑时，提交返回 `CONFLICT`，任务以 `CONFLICT` 失败，保留用户编辑。删除会议会中止进行中的请求；退出时先记录 `INTERRUPTED` 再中止，迟到的响应不会提交。

## 请求参数

`requestChatCompletion` 固定发送：

- `response_format: { type: 'json_object' }`，prompt 中包含 "json" 和示例结构（JSON Output 的要求）。
- `thinking: { type: 'disabled' }`：纪要不需要思维链，content 中不混入推理过程。
- `max_tokens: 8192`，显式设置以免输出截断。
- 模型来自设置 `deepseekModel`，默认 `deepseek-flash`（`deepseek-chat` 已于 2026-07-24 停用）。
- 单次请求超时 120 秒。

## 错误映射

错误只带错误码和 `retryable` 标记，不读取也不保存 DeepSeek 的错误正文（可能回显请求内容）。

| 情况 | 错误码 | retryable |
| --- | --- | --- |
| 401、403 | `DEEPSEEK_UNAUTHORIZED` | 否 |
| 429 | `DEEPSEEK_RATE_LIMITED` | 是 |
| 500、503、网络错误、`insufficient_system_resource` | `DEEPSEEK_UNAVAILABLE` | 是 |
| 402 余额不足 | `DEEPSEEK_UNAVAILABLE` | 否 |
| 400、422（本地请求构造问题） | `INTERNAL` | 否 |
| 超时 | `DEEPSEEK_TIMEOUT` | 是 |
| 响应不是 JSON、结构不符、空 content、`finish_reason` 不是 `stop` | `DEEPSEEK_INVALID_RESPONSE` | 否 |
| 调用方中止（删除、退出） | `INTERRUPTED` | 否 |

`retryable` 供 #19 的有界重试使用；当前请求层不自动重试。

## Prompt 与校验

- `buildNoteMessages(segments, context)` 返回 system + user 两条消息。转写逐行写成 `[startMs] text`。
- `owner`/`dueDate` 只有原文明确出现时填写，否则为 `unspecified`。
- `parseNoteResponse(content)` 拒绝以下输出，统一抛出 `DEEPSEEK_INVALID_RESPONSE`：无效 JSON、代码块包裹、截断、字段缺失或多余、类型错误、`null` 或空串、负数或小数时间戳、空 `summary`。`Unspecified` 等大小写或空白变体统一成 `unspecified`。
- 转写、关键词和中间纪要都作为数据放在标签内，并说明其中的内容不是指令；数据中的 `<`、`>` 不能闭合标签。

schema 只校验结构，不核验事实。内容是否忠于转写，由用户回看转写和编辑确认。

## 关键词引导（#20）

`meeting.keywords` 放在 user 消息中、转写之前，要求模型对相关讨论写得更详细。prompt 明确关键词是用户关注点而不是会议事实：转写没讨论到的关键词不出现在纪要中，也不为它新增条目。

## 来源时间（#20）

决策和行动项的 `timestampMs` 只能是某个转写片段的 `startMs`：

- 单段生成：只保留与该段某个片段 `startMs` 完全相同的值，其他值删除。不就近吸附、不补造。
- 合并：只保留中间纪要中已经核对过的值。合并步骤不能引入新的来源时间。
- 无可靠来源的条目不带 `timestampMs`。

## 长转写分段（#18）

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `CHUNK_CHAR_BUDGET` | 24,000 字符 | 单次请求的转写预算，按 `[startMs] text` 格式化后的长度计算 |
| `MAX_CHUNKS` | 12 段 | 约 28.8 万字符；超过返回 `TRANSCRIPT_TOO_LONG`，不截断 |

策略：

1. 转写不超过一段预算时一次请求，没有合并步骤。
2. 超过时只在片段边界切分，每个片段恰好属于一段，顺序不变。单个超长片段独占一段，不拆开。
3. 每段按段号（"第 i 段，共 n 段"）生成中间纪要，并各自校验和核对来源时间。
4. 中间纪要以 JSON 数组发送给合并 prompt，生成最终纪要。合并请求不包含原始转写。
5. 最终纪要按文本（忽略大小写和空白）去除完全重复的条目：重复条目取最早的来源时间；负责人或日期一方为 `unspecified` 时取明确的值。语义上的重复由合并 prompt 处理。
6. 任一段或合并失败，整次生成失败，不提交部分结果。

进度按已完成请求数计算：`n` 段时共 `n + 1` 个请求，开始时上报 0，最后一个完成时上报 100。

预算按字符而不是 token 计算，在模型的 1M 上下文内留有很大余量；选择较小的分段是为了控制单次请求时长和输出质量，后续可按真实会议数据调整。

## Fixture 与测试

- `tests/fixtures/note-responses.json`：对应 `sample-transcript.json`，`valid` 为可提交的 content，`invalid` 为必须拒绝的 content。
- `tests/note-prompt.test.mjs`：prompt 和校验。
- `tests/deepseek-client.test.mjs`：请求参数、#13 mock 的限流/无效 JSON/超时、HTTP 状态映射、截断和中止。
- `tests/note-pipeline.test.mjs`：分段边界、超限拒绝、来源核对、去重、关键词、部分失败和合并失败。
- `tests/note-generation.test.mjs`：正式 Main 编排 + dispatcher + SQLite + #13 mock，覆盖生成落库、无 Key、失败保留编辑、重新生成新增版本、生成期间编辑冲突、删除和退出。

这些测试只使用 mock，不代表真实 DeepSeek 输出质量。
