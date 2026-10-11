# 数据库 Schema

SQLite 数据库，使用 `better-sqlite3`，存储路径 `userData/turnnote.db`。

## 表结构

### meetings

| 列 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| title | TEXT | NOT NULL |
| status | TEXT | NOT NULL, CHECK(status IN ('created','recording','captured','transcribing','transcribed','generating','ready','failed','deleted')) |
| retain_audio | INTEGER | NOT NULL DEFAULT 0 |
| keywords | TEXT | NOT NULL DEFAULT '[]', JSON 数组 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

`keywords` 存储用户标注的关键词（JSON 数组，如 `["定价讨论","技术债务"]`），用于引导 AI 生成纪要。

索引：`CREATE INDEX idx_meetings_status ON meetings(status)`

### audio_assets

| 列 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| meeting_id | TEXT | NOT NULL, FOREIGN KEY REFERENCES meetings(id) ON DELETE CASCADE |
| file_path | TEXT | NOT NULL |
| created_at | TEXT | NOT NULL |

唯一索引 idx_audio_one_per_meeting(meeting_id) 覆盖查询；文件路径另设唯一索引 idx_audio_one_owner。

### transcript_segments

| 列 | 类型 | 约束 |
|---|---|---|
| meeting_id | TEXT | NOT NULL, FOREIGN KEY REFERENCES meetings(id) ON DELETE CASCADE |
| sequence | INTEGER | NOT NULL |
| start_ms | INTEGER | NOT NULL |
| end_ms | INTEGER | NOT NULL |
| text | TEXT | NOT NULL |

主键：`PRIMARY KEY (meeting_id, sequence)`

复合主键索引已覆盖 meeting_id 查询，不额外建立重复索引。

### note_versions

| 列 | 类型 | 约束 |
|---|---|---|
| meeting_id | TEXT | NOT NULL, FOREIGN KEY REFERENCES meetings(id) ON DELETE CASCADE |
| version | INTEGER | NOT NULL |
| source | TEXT | NOT NULL, CHECK(source IN ('generated','user')) |
| content_json | TEXT | NOT NULL |
| created_at | TEXT | NOT NULL |

主键：`PRIMARY KEY (meeting_id, version)`

最新版本：`SELECT * FROM note_versions WHERE meeting_id = ? ORDER BY version DESC LIMIT 1`

`content_json` 结构（符合 `MeetingNote` 类型）：
```json
{
  "summary": "...",
  "keyTopics": ["..."],
  "decisions": [{"text": "...", "timestampMs": 12300}],
  "openQuestions": ["..."],
  "actionItems": [{"task": "...", "owner": "...", "dueDate": "...", "timestampMs": 45600}]
}
```

`timestampMs` 用于跳转到对应转写片段。

### processing_jobs

| 列 | 类型 | 约束 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| meeting_id | TEXT | NOT NULL, FOREIGN KEY REFERENCES meetings(id) ON DELETE CASCADE |
| kind | TEXT | NOT NULL, CHECK(kind IN ('recording','transcribing','generating')) |
| status | TEXT | NOT NULL, CHECK(status IN ('pending','running','completed','failed','cancelled')) |
| attempt | INTEGER | NOT NULL DEFAULT 1 |
| base_note_version | INTEGER | 生成开始时的纪要版本，首次为 0；其他任务为 NULL |
| error_code | TEXT | NULL |
| error_message | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

索引：`CREATE INDEX idx_jobs_meeting_kind ON processing_jobs(meeting_id, kind)`

部分唯一索引 `idx_jobs_one_active` 保证每个会议最多一个 pending/running 任务。只有 failed job 可以有 error_code/error_message，错误信息来自共享安全目录。音频使用 `idx_audio_one_per_meeting` 限制每会议一份当前引用，`idx_audio_one_owner` 禁止不同会议共享同一个文件路径。

### app_settings

| 列 | 类型 | 约束 |
|---|---|---|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

key 白名单：microphoneDeviceId、includeSystemAudio、transcriptionModel、transcriptionLanguage、deepseekModel。value 为 JSON；未知字段（包括 API Key）在共享 schema 和 SQL CHECK 两层拒绝。API Key 的系统凭证实现属于 #16。

## 迁移

`PRAGMA user_version` 追踪 schema 版本。正式迁移在 `apps/desktop/main/storage/migrations/`：001_initial 建立六表，002_job_lifecycle 增加录音和取消任务、生成版本基线、活动任务和音频唯一索引。当前版本为 2。

Main 获取 IMMEDIATE 写锁后读取版本，将所有待执行迁移整批原子提交。任一步失败回滚数据、schema 与 user_version；高于当前应用的数据库版本拒绝打开，不降级或重建。SQL 通过 ?raw 打包进 Main，测试构建同样读取正式 SQL。

启用：`PRAGMA foreign_keys = ON`

启用 WAL 和 5 秒 busy timeout。数据库路径为 userData/turnnote.db；音频引用只接受 userData/audio 内的绝对路径，不向 Renderer 暴露。Main 保持单实例，文件副作用同步协调；数据库事务不执行文件或网络操作。

## 状态机

```
created → recording → captured → transcribing → transcribed → generating → ready
            ↓                         ↓                           ↓
          failed                    failed                      failed
```

| 转换 | 条件 |
|---|---|
| `recording → captured` | WAV finalize 成功，录音 job 完成；stop 固定返回 captured，自动转写随后由事件报告 |
| `recording / failed(recording) → created` | 用户显式取消并清理本次音频；历史错误保留，当前 lastError 清空 |
| `failed → transcribing` | 最近失败 job 的 `kind='transcribing'`，且音频仍存在 |
| `failed → generating` | 最近失败 job 的 `kind='generating'` |
| `ready → generating` | 用户重新生成（如修改关键词） |
| `transcribing → captured` | 用户取消转写 |
| 任意 → `deleted` | 用户删除会议 |

`failed` 的失败阶段和原因记录在 `processing_jobs`。生成失败不影响已保存的转写和纪要版本。

每次任务启动都新建 job ID，attempt 按会议和阶段递增。取消记 cancelled；失败、取消和删除使旧 ID 失效，旧结果提交返回 false。activeJobId 从当前活动 job 推导。片段/纪要、任务完成和会议状态须在一次事务中提交。

纪要编辑传入 expectedVersion；版本不符返回 CONFLICT。生成完成时与 base_note_version 比较；期间出现新用户编辑则拒绝提交，调用方以 CONFLICT 结束该 job，保留最新编辑。用户编辑不覆盖历史版本。

## 删除

1. 会议标记 `deleted`，活动任务记 cancelled
2. 删除音频文件
3. 删除 `meetings` 行，级联删除关联数据

`deleted` 只是删除过程中的中间状态，列表查询排除该状态。

get 同样排除 deleted。文件删除失败返回 WRITE_FAILED 并保留墓碑和音频引用，重试或启动后继续。缺失文件视为已清理；实际删除检查音频父目录 realpath，拒绝经符号链接访问管理目录之外的文件。

## 崩溃恢复

应用启动时检查：

| 状态 | 处理 |
|---|---|
| `recording` | #5 接入后调用 repairWavHeader，成功完成 recording job 并改为 captured，失败以 INTERRUPTED 结束；当前保留原状态和音频，不伪装恢复成功 |
| `transcribing` / `generating` | 改为 `failed`，写入 `error_code='INTERRUPTED'` 的失败 job |
| `deleted` | 继续执行删除步骤 2、3 |

当前启动恢复覆盖 pending/running 的转写和生成任务，更新原 job 为 failed/INTERRUPTED，不创建重复恢复 job，不自动重试。

## 音频保留

- 转写成功且 `retain_audio=0`：删除音频文件和 `audio_assets` 行
- 转写失败：保留音频，允许重试
- `audio_assets` 行存在即表示音频已保留

音频登记要求绝对路径位于管理目录内，父目录已存在。登记时将父目录和管理根目录按 realpath 规范化，并再次检查实际路径边界；目录内部的符号链接别名保存为同一个规范路径，由唯一索引阻止跨会议共享。文件本身不得为符号链接；文件可以尚未创建，以支持录音开始前预留所有权。调用方须使用 `getAudio().filePath` 返回的规范路径读写文件。

hasAudio 表示音频引用存在，实际文件存在性由 Main 在启动任务前验证。`removeAudioReference` 仅清数据库引用，调用方须在检查保留标志后同步清文件并立即提交；真实自动清理策略将在音频编排中实现。

## 数据库入口与验证

`MeetingStore` 提供会议 CRUD、音频引用、任务启动/取消/失败/完成、转写/纪要版本和设置存取。`createStorageHandlers` 接入现有 IPC，仅注册已经实现的业务方法；真实采集、转写、生成和凭证操作仍返回 NOT_IMPLEMENTED。

运行 `npm test -- tests/storage.test.mjs` 验证新库、v1 升级、失败迁移回滚、重启持久化、非法状态、SQL 注入输入、真实 SQL 故障事务回滚、任务令牌、编辑冲突、删除和设置白名单。
