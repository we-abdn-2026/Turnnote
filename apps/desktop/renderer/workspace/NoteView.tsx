// 纪要阅读视图：像剪辑决定表一样，每条决策和行动项都带可定位的入点时间码。
import { Fragment, type ReactElement } from 'react';
import type { MeetingNote, TranscriptSegment } from '@shared/contracts';
import { Icon } from '../ui/icons';
import { formatTimecode } from '@shared/timecode';
import { segmentIndexAt } from '../ui/timecode';

function displayNoteValue(value: string): string {
  const normalized = value.trim();
  return normalized === '' || normalized.toLowerCase() === 'unspecified' ? '未指定' : normalized;
}

function isUnspecified(value: string): boolean {
  return displayNoteValue(value) === '未指定';
}

function SourceCue({
  timestampMs,
  segments,
  onCue,
}: {
  timestampMs: number | undefined;
  segments: TranscriptSegment[];
  onCue(timestampMs: number): void;
}): ReactElement {
  if (timestampMs === undefined) {
    return (
      <span className="note-nosource" title="没有可核对的来源时间，请对照转写人工确认">
        无来源
      </span>
    );
  }
  const found = segmentIndexAt(segments, timestampMs) !== -1;
  const code = formatTimecode(timestampMs);
  return (
    <button
      type="button"
      className="cue"
      aria-label={`定位到转写 ${code}`}
      title={found ? '定位到转写中的来源' : '转写中没有这个时间点'}
      disabled={!found}
      onClick={() => onCue(timestampMs)}
    >
      <Icon name="cue" size={12} />
      <time className="note-time">{code}</time>
    </button>
  );
}

export function NoteView({
  note,
  segments,
  onCue,
  linkedMs,
}: {
  note: MeetingNote;
  segments: TranscriptSegment[];
  onCue(timestampMs: number): void;
  /** 转写里正被悬停的行入点；引用它的条目显示为关联状态 */
  linkedMs: number | null;
}): ReactElement {
  const linked = (timestampMs: number | undefined): string | undefined =>
    linkedMs !== null && timestampMs === linkedMs ? 'true' : undefined;
  return (
    <article className="note-content">
      <section className="note-summary" aria-labelledby="note-summary-heading">
        <h4 id="note-summary-heading">摘要</h4>
        <p>
          {(note.summary.trim() || '未填写').split('\n').map((paragraph, index) => (
            <Fragment key={index}>
              {index > 0 && '\n'}
              <span className="para">{paragraph}</span>
            </Fragment>
          ))}
        </p>
      </section>

      <section className="note-section" aria-labelledby="note-topics-heading">
        <h4 id="note-topics-heading">关键主题</h4>
        {note.keyTopics.length > 0 ? (
          <ul className="note-topics" aria-label="关键主题">
            {note.keyTopics.map((topic, index) => (
              <li key={`${index}-${topic}`}>{topic.trim() || '未指定'}</li>
            ))}
          </ul>
        ) : (
          <p className="note-empty">未指定</p>
        )}
      </section>

      <section className="note-section" aria-labelledby="note-decisions-heading">
        <h4 id="note-decisions-heading">决策</h4>
        {note.decisions.length > 0 ? (
          <ol className="note-list edl" aria-label="决策">
            {note.decisions.map((decision, index) => (
              <li
                className="edl-row"
                data-linked={linked(decision.timestampMs)}
                key={`${index}-${decision.timestampMs ?? 'no-time'}`}
              >
                <span className="note-item-text">{decision.text.trim() || '未指定'}</span>
                <SourceCue timestampMs={decision.timestampMs} segments={segments} onCue={onCue} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="note-empty">未指定</p>
        )}
      </section>

      <section className="note-section" aria-labelledby="note-questions-heading">
        <h4 id="note-questions-heading">未决问题</h4>
        {note.openQuestions.length > 0 ? (
          <ol className="note-list edl" aria-label="未决问题">
            {note.openQuestions.map((question, index) => (
              <li className="edl-row" key={`${index}-${question}`}>
                <span className="note-item-text">{question.trim() || '未指定'}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note-empty">未指定</p>
        )}
      </section>

      <section className="note-section" aria-labelledby="note-actions-heading">
        <h4 id="note-actions-heading">行动项</h4>
        {note.actionItems.length > 0 ? (
          <ol className="note-list note-action-list edl" aria-label="行动项">
            {note.actionItems.map((item, index) => (
              <li
                className="note-action edl-row"
                data-linked={linked(item.timestampMs)}
                key={`${index}-${item.timestampMs ?? 'no-time'}`}
              >
                <div className="note-action-main">
                  <span className="note-item-text">{item.task.trim() || '未指定'}</span>
                  <SourceCue timestampMs={item.timestampMs} segments={segments} onCue={onCue} />
                </div>
                <dl className="note-action-meta">
                  <div>
                    <dt>负责人</dt>
                    <dd data-unspecified={isUnspecified(item.owner) ? 'true' : undefined}>
                      {displayNoteValue(item.owner)}
                    </dd>
                  </div>
                  <div>
                    <dt>截止时间</dt>
                    <dd data-unspecified={isUnspecified(item.dueDate) ? 'true' : undefined}>
                      {displayNoteValue(item.dueDate)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note-empty">未指定</p>
        )}
      </section>
    </article>
  );
}
