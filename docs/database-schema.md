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
| keywords | TEXT | NULL |
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

索引：`CREATE INDEX idx_audio_meeting ON audio_assets(meeting_id)`

### transcript_segments

| 列 | 类型 | 约束 |
|---|---|---|
| meeting_id | TEXT | NOT NULL, FOREIGN KEY REFERENCES meetings(id) ON DELETE CASCADE |
| sequence | INTEGER | NOT NULL |
| start_ms | INTEGER | NOT NULL |
| end_ms | INTEGER | NOT NULL |
| text | TEXT | NOT NULL |

主键：`PRIMARY KEY (meeting_id, sequence)`

索引：`CREATE INDEX idx_transcript_meeting ON transcript_segments(meeting_id)`

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
| kind | TEXT | NOT NULL, CHECK(kind IN ('transcribing','generating')) |
| status | TEXT | NOT NULL, CHECK(status IN ('pending','running','completed','failed')) |
| attempt | INTEGER | NOT NULL DEFAULT 1 |
| error_code | TEXT | NULL |
| error_message | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

索引：`CREATE INDEX idx_jobs_meeting_kind ON processing_jobs(meeting_id, kind)`

### app_settings

| 列 | 类型 | 约束 |
|---|---|---|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

存储：音频设备 ID、转写模型、转写语言、DeepSeek 模型。API Key 使用系统 keychain，不存入此表。

## 迁移

`PRAGMA user_version` 追踪 schema 版本，启动时执行 `migrations/` 中编号的 `.sql` 文件。

启用：`PRAGMA foreign_keys = ON`

## 状态机

```
created → recording → captured → transcribing → transcribed → generating → ready
          ↓           ↓           ↓                ↓            ↓
          failed      failed      failed           failed       failed
```

`failed` 状态时 `processing_jobs` 记录失败阶段和原因。

## 崩溃恢复

应用启动时检查：
- `status='recording'`：尝试修复 WAV header，成功改为 `captured`，失败改为 `failed`
- `status='transcribing'` 或 `'generating'`：标记 `failed`，创建 `error_code='INTERRUPTED'` 的失败 job

## 音频删除策略

成功转写后，若 `retain_audio=0`，删除 `audio_assets` 行和对应文件。

转写失败时保留音频，允许重试。

删除会议时级联删除所有关联数据。
