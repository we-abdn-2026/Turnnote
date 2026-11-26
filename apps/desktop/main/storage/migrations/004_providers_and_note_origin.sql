-- 用户自定义的 OpenAI 兼容 AI 服务商（Ollama、各家兼容网关等）。Key 不在这里：按服务商 id 存系统安全存储。
CREATE TABLE custom_providers (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  base_url TEXT NOT NULL CHECK(length(base_url) BETWEEN 8 AND 200),
  needs_key INTEGER NOT NULL DEFAULT 1 CHECK(needs_key IN (0,1)),
  created_at TEXT NOT NULL
);

-- 每个 AI 生成的纪要版本记录是谁生成的（{"provider","label","model"}）；用户编辑和历史版本为 NULL。
ALTER TABLE note_versions ADD COLUMN generated_by TEXT
  CHECK(generated_by IS NULL OR json_valid(generated_by));
