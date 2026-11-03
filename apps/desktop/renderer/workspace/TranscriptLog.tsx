// 场记单：按入点时间码排列转写片段，处理进度显示在场记表头。纪要的来源时间码在这里定位。
import { useEffect, useRef, type ReactElement } from 'react';
import type { TranscriptSegment } from '@shared/contracts';
import { Icon } from '../ui/icons';
import { formatDuration, formatTimecode } from '../ui/timecode';
import {
  TRANSCRIPT_LOAD_FAILED_MESSAGE,
  meetingActions,
  type MeetingSession,
  type SessionState,
} from './meeting-session';
import { ProcessingProgress } from './ProcessingProgress';

/** 一次定位：nonce 每次递增，同一行再次定位也会重放扫描 */
export interface Cue {
  index: number;
  nonce: number;
}

interface TranscriptLogProps {
  session: MeetingSession;
  state: SessionState;
  cue: Cue | null;
  onClose(): void;
}

export function TranscriptLog({ session, state, cue, onClose }: TranscriptLogProps): ReactElement {
  const listRef = useRef<HTMLOListElement>(null);
  const meeting = state.meeting!;
  const manage = meetingActions(state);
  const segments = state.transcriptSegments;
  const showRetry =
    segments.length === 0 &&
    (meeting.status === 'captured' ||
      (meeting.status === 'failed' && meeting.lastError?.kind === 'transcribing'));

  useEffect(() => {
    if (!cue) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-segment-index="${cue.index}"]`);
    if (!row) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    row.focus({ preventScroll: true });
  }, [cue]);

  return (
    <section className="transcript log" aria-labelledby="transcript-heading">
      <div className="transcript-heading drawer-head">
        <h3 id="transcript-heading">转写</h3>
        <button type="button" className="key key-icon key-quiet" title="收起转写" onClick={onClose}>
          <Icon name="close" />
          <span className="visually-hidden">收起转写</span>
        </button>
      </div>

      {meeting.status === 'transcribing' && (
        <ProcessingProgress
          state={state}
          action={
            manage.cancelTranscription || state.pending === 'cancelTranscription' ? (
              <button
                type="button"
                className="key key-quiet"
                onClick={() => void session.cancelTranscription()}
                disabled={!manage.cancelTranscription}
              >
                {state.pending === 'cancelTranscription' ? '正在取消...' : '取消转写'}
              </button>
            ) : null
          }
        />
      )}

      {state.transcriptState === 'loading' && segments.length === 0 && (
        <div className="log-skeleton">
          <p className="transcript-message" role="status">
            正在加载转写内容...
          </p>
          {[0, 1, 2, 3].map((key) => (
            <span key={key} className="skeleton-row" aria-hidden="true" />
          ))}
        </div>
      )}

      {state.transcriptState === 'error' && (
        <div className="transcript-error panel-fault" role="alert">
          <p>{TRANSCRIPT_LOAD_FAILED_MESSAGE}</p>
          <button
            type="button"
            className="key key-quiet"
            onClick={() => void session.reloadTranscript()}
          >
            <Icon name="refresh" />
            重新加载
          </button>
        </div>
      )}

      {state.transcriptState === 'ready' && segments.length === 0 && (
        <div className="log-empty">
          <p className="transcript-message">暂无转写内容</p>
          {showRetry && (
            <button
              type="button"
              className="key"
              onClick={() => void session.retryTranscription()}
              disabled={!manage.transcribe}
            >
              <Icon name="refresh" />
              {state.pending === 'transcribe' ? '正在开始转写...' : '重新转写'}
            </button>
          )}
        </div>
      )}

      {segments.length > 0 && (
        <ol ref={listRef} className="transcript-list" aria-label="转写片段">
          {segments.map((segment, index) => (
            <Segment
              key={
                cue?.index === index
                  ? `${index}-${segment.startMs}-${segment.endMs}-cue${cue.nonce}`
                  : `${index}-${segment.startMs}-${segment.endMs}`
              }
              segment={segment}
              index={index}
              cued={cue?.index === index}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function Segment({
  segment,
  index,
  cued,
}: {
  segment: TranscriptSegment;
  index: number;
  cued: boolean;
}): ReactElement {
  const duration = segment.endMs - segment.startMs;
  return (
    <li
      className={`transcript-segment${cued ? ' is-cued' : ''}`}
      id={`transcript-segment-${index}`}
      data-segment-index={index}
      data-start-ms={segment.startMs}
      data-end-ms={segment.endMs}
      aria-current={cued ? 'true' : undefined}
      tabIndex={-1}
    >
      <time
        className="transcript-time"
        title={`${formatTimecode(segment.startMs)}–${formatTimecode(segment.endMs)}，${formatDuration(duration)}`}
      >
        {formatTimecode(segment.startMs)}
      </time>
      <span className="transcript-text">{segment.text}</span>
    </li>
  );
}
