CREATE TABLE meetings (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK(status IN ('created','recording','captured','transcribing','transcribed','generating','ready','failed','deleted')),
  retain_audio INTEGER NOT NULL DEFAULT 0 CHECK(retain_audio IN (0,1)),
  keywords TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(keywords) AND json_type(keywords) = 'array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_meetings_status ON meetings(status);

CREATE TABLE audio_assets (
  id TEXT PRIMARY KEY NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audio_meeting ON audio_assets(meeting_id);

CREATE TABLE transcript_segments (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  text TEXT NOT NULL CHECK(length(text) > 0),
  PRIMARY KEY(meeting_id, sequence)
);

CREATE TABLE note_versions (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version >= 1),
  source TEXT NOT NULL CHECK(source IN ('generated','user')),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(meeting_id, version)
);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('transcribing','generating')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_meeting_kind ON processing_jobs(meeting_id, kind);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK(key IN ('microphoneDeviceId','includeSystemAudio','transcriptionModel','transcriptionLanguage','deepseekModel')),
  value TEXT NOT NULL CHECK(json_valid(value))
);
