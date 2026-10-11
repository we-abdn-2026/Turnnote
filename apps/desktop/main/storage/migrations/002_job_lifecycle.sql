-- 一个会议只有一份当前音频，以及一个未结束任务。
CREATE UNIQUE INDEX idx_audio_one_per_meeting ON audio_assets(meeting_id);
DROP INDEX idx_audio_meeting;
CREATE UNIQUE INDEX idx_audio_one_owner ON audio_assets(file_path);

ALTER TABLE processing_jobs RENAME TO processing_jobs_v1;
CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('recording','transcribing','generating')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  base_note_version INTEGER CHECK(base_note_version IS NULL OR base_note_version >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (status != 'failed' AND error_code IS NULL AND error_message IS NULL))
);
INSERT INTO processing_jobs(id, meeting_id, kind, status, attempt, error_code, error_message, created_at, updated_at)
SELECT id, meeting_id, kind, status, attempt, error_code, error_message, created_at, updated_at
FROM processing_jobs_v1 ORDER BY rowid;
DROP TABLE processing_jobs_v1;
CREATE INDEX idx_jobs_meeting_kind ON processing_jobs(meeting_id, kind);
CREATE UNIQUE INDEX idx_jobs_one_active ON processing_jobs(meeting_id) WHERE status IN ('pending','running');
