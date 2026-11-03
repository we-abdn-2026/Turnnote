-- #16 将 deepseekModel 拆为 noteProvider + noteModel；CHECK 白名单同步更新。
-- SQLite 不能 ALTER CHECK，因此重建表。已有 deepseekModel 行迁移为 noteModel。

ALTER TABLE app_settings RENAME TO app_settings_v2;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL CHECK(key IN (
    'microphoneDeviceId',
    'includeSystemAudio',
    'transcriptionModel',
    'transcriptionLanguage',
    'noteProvider',
    'noteModel'
  )),
  value TEXT NOT NULL CHECK(json_valid(value))
);

INSERT INTO app_settings(key, value)
SELECT
  CASE key WHEN 'deepseekModel' THEN 'noteModel' ELSE key END,
  value
FROM app_settings_v2
WHERE key IN (
  'microphoneDeviceId',
  'includeSystemAudio',
  'transcriptionModel',
  'transcriptionLanguage',
  'deepseekModel'
);

-- 只要库里曾有 deepseekModel，或尚无 noteProvider，就补上默认 provider。
INSERT OR IGNORE INTO app_settings(key, value)
SELECT 'noteProvider', '"deepseek"'
WHERE EXISTS (
  SELECT 1 FROM app_settings_v2 WHERE key = 'deepseekModel'
)
OR NOT EXISTS (
  SELECT 1 FROM app_settings WHERE key = 'noteProvider'
);

DROP TABLE app_settings_v2;
