# 错误处理与恢复

`packages/contracts/src/result.ts` 是安全文案、错误码识别和恢复分类的唯一来源。
Main 的 `fail` / `TurnnoteError`、存储读取和 Renderer 都使用该目录，界面不展示
响应正文、底层异常或未知错误自带的 `message`。

## 分类与界面

| 分类 | 示例 | 用户恢复方式 |
| --- | --- | --- |
| `retry` | `AI_TIMEOUT`、`AI_RATE_LIMITED`、`AI_UNAVAILABLE`、`SIDECAR_TIMEOUT` | 满足任务状态后重试；生成仍须确认发送 |
| `settings` | `API_KEY_MISSING`、`AI_UNAUTHORIZED`、`AI_PROVIDER_NOT_CONFIGURED`、`AI_PAYMENT_REQUIRED`、`AI_REQUEST_REJECTED`、`AI_INVALID_RESPONSE` | 检查凭证、服务账户、服务商地址或模型；不自动重发 |
| `permissions` | `PERMISSION_DENIED` | 调用既有 `recording.openPermissionSettings('microphone')`；系统音频权限继续由音频设备面板处理 |
| `reload` | `CONFLICT`、`NOT_FOUND`、`INVALID_STATE` | 使用所属界面的重新加载或关闭入口；编辑冲突保留草稿 |
| `none` | `AUDIO_NOT_FOUND`、`AUDIO_DECODE_FAILED`、`WRITE_FAILED`、`INSUFFICIENT_DISK_SPACE` | 按固定提示检查音频、磁盘或权限，不提供无效的自动重试 |

分类是恢复指引，不授权绕过业务状态、用户确认或删除流程。`AiRequestError.retryable`
表示请求适合重试；用户主动取消的 `INTERRUPTED` 为 false，即使用户之后可以重新启动任务。
当前请求层不自动重试，不因错误恢复再次发送会议内容。

`MeetingWorkspace` 为即时 IPC 失败和持久化任务失败提供恢复入口：设置问题打开设置；
生成失败的重试打开原发送确认；转写失败重试已有音频；打开权限设置失败仍显示固定安全信息。
旧任务的错误不会决定一个新任务的重试行为。

## 服务商与历史数据

请求层为 `apps/desktop/main/services/ai-client.ts`，使用 `AI_*` 错误码。
不存在的服务商或无效端点返回 `AI_PROVIDER_NOT_CONFIGURED`，不会落成 `INTERNAL`，
也不会创建生成任务或发送转写。HTTP 402 单独映射为 `AI_PAYMENT_REQUIRED`，与临时服务故障区分。

数据库迁移 6 把五种历史 `DEEPSEEK_*` 错误码转换为对应 `AI_*`。迁移在原有事务中执行，
失败时所有码和 `user_version` 一起回滚；会议、转写、音频引用、纪要版本和任务状态保持原值。
历史 `error_message` 保留在数据库，但读取会议和任务时均从当前安全目录生成文案；
未知历史码只返回 `INTERNAL`。旧协议码不继续作为新调用的输入。

## 调用示例

```ts
import { errorInfo } from '@shared/result';

const info = errorInfo(result.error.code);
// info.message 可安全展示；忽略 result.error.message 中的未知内容。
if (info.recovery === 'settings') openSettings();
// retry 入口仍检查当前任务和用户确认，不在收到错误时直接重发。
```

`tests/error-recovery.test.mjs` 覆盖目录、异常兜底、请求前拒绝和迁移/回滚；
`tests/error-recovery-ui.test.mjs` 挂载真实工作区，验证设置、权限和发送确认路径。
AI HTTP 错误与取消测试见 `tests/deepseek-client.test.mjs`；该文件沿用历史名称。
