# 纪要生成：Prompt 与输出校验

实现：`apps/desktop/main/services/note-prompt.ts`（#15）。请求层（#17 `services/deepseek.ts`）、长文本分段（#18）和关键词引导（#20）复用本模块，不另建 schema。

## 契约

- 结构唯一来源：`packages/contracts` 的 `MeetingNote` 类型和 `meetingNoteSchema`。本模块只负责 prompt 和模型输出解析。
- 请求：`buildNoteMessages(segments)` 返回 system + user 两条消息；配合 `response_format: NOTE_RESPONSE_FORMAT`（DeepSeek JSON Output）。
- 转写按行发送 `[startMs] text`。决策和行动项的 `timestampMs` 应复制所依据行的 `startMs`；无单一依据时省略，不补造。
- `owner`/`dueDate` 只有原文明确出现时填写，否则为 `unspecified`。

## 校验

`parseNoteResponse(content)` 接收 assistant message content：

| 输入 | 结果 |
| --- | --- |
| 合法 JSON 且通过 `meetingNoteSchema` | 返回 `MeetingNote` |
| `owner`/`dueDate` 为 `Unspecified`、带空白等 | 统一为 `unspecified` |
| 非字符串、无效 JSON、Markdown 代码块包裹、截断 | `DEEPSEEK_INVALID_RESPONSE` |
| 字段缺失/多余、类型错误、`null`/空串、负数或小数时间戳 | `DEEPSEEK_INVALID_RESPONSE` |
| 空 `summary` | `DEEPSEEK_INVALID_RESPONSE`（用户编辑允许为空，生成结果不允许） |

错误只带固定安全文案，不含模型输出或转写正文。调用方在校验失败时用 `failJob(jobId, 'DEEPSEEK_INVALID_RESPONSE')` 结束任务，不调用 `completeGeneration`；已有转写和纪要版本保持不变。

schema 只校验结构，不核验事实：内容是否忠于转写、`timestampMs` 是否对应真实片段，由 #20 的来源校验以及用户回看和编辑确认。

## Fixture

`tests/fixtures/note-responses.json` 对应 `sample-transcript.json`，`valid` 为可提交的 content，`invalid` 为必须拒绝的 content，供 #17/#18/#20 测试共用。
