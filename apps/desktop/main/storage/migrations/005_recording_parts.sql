-- 一场会议可以有多段录音（暂停后继续、对已转写的会议追加）。
-- 每段音频是 audio_assets 的一行：part_no 决定先后，transcribed_at 为空表示还没转写（待处理）。
-- 转写完成并按保留策略清理后，音频行会被删除，所以时间线长度记在会议上而不是推导。

DROP INDEX idx_audio_one_per_meeting;
ALTER TABLE audio_assets ADD COLUMN part_no INTEGER NOT NULL DEFAULT 1 CHECK(part_no >= 1);
ALTER TABLE audio_assets ADD COLUMN transcribed_at TEXT;
CREATE UNIQUE INDEX idx_audio_part ON audio_assets(meeting_id, part_no);

-- 已有数据来自"一场会议一份音频"的时代：会议已有转写，那份音频就已经转写过。
UPDATE audio_assets SET transcribed_at = (SELECT updated_at FROM meetings WHERE id = audio_assets.meeting_id)
WHERE EXISTS (SELECT 1 FROM transcript_segments s WHERE s.meeting_id = audio_assets.meeting_id);

-- timeline_ms：已转写录音的总时长，下一段录音的转写从这里开始计时。
-- 旧数据没有保存时长，用最后一个片段的结束时间近似（只影响之后追加的录音的起点）。
ALTER TABLE meetings ADD COLUMN timeline_ms INTEGER NOT NULL DEFAULT 0 CHECK(timeline_ms >= 0);
UPDATE meetings SET timeline_ms = COALESCE(
  (SELECT MAX(end_ms) FROM transcript_segments s WHERE s.meeting_id = meetings.id), 0);

-- transcript_revision：转写每提交一次加 1；纪要记录它生成时看到的修订，落后即视为"没有包含新内容"。
ALTER TABLE meetings ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0 CHECK(transcript_revision >= 0);
ALTER TABLE note_versions ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0 CHECK(transcript_revision >= 0);
