// 会议库：像文件夹列表。顶部一行新建（输入 + 按钮），下面按日期分组的会议，当前会议高亮。
// 状态只用一个圆点表达；没有状态文字和日期标签。列表只读 Main，切换由会话层守卫。
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
} from 'react';
import { Icon } from '../ui/icons';
import { shortcutLabel } from '../ui/shortcuts';
import { SHORT_STATUS, STATUS_DOT } from '../ui/timecode';
import {
  availableActions,
  isRecording,
  meetingActions,
  type MeetingSession,
  type SessionState,
} from '../workspace/meeting-session';
import type { LibraryItem, MeetingLibrary } from './meeting-library';

interface LibraryProps {
  session: MeetingSession;
  state: SessionState;
  library: MeetingLibrary;
  /** 窄窗口下抽屉是否展开；宽窗口始终显示 */
  open: boolean;
  onClose(): void;
}

const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return dayFormat.format(date);
}

function groupByDay(items: LibraryItem[]): { label: string; items: LibraryItem[] }[] {
  const groups: { label: string; items: LibraryItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function Library({ session, state, library, open, onClose }: LibraryProps): ReactElement {
  const view = useSyncExternalStore(library.subscribe, library.getState);
  const [title, setTitle] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const actions = availableActions(state);
  const manage = meetingActions(state);
  const recording = isRecording(state);
  const savePending = state.meeting?.status === 'recording' && state.captureStopped;
  const blocked = recording || savePending;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      // 对话框打开时 Escape 只关闭对话框
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await session.create(title)) {
      setTitle('');
      onClose();
    }
  }

  async function handleOpen(id: string): Promise<void> {
    if (await session.open(id)) onClose();
  }

  async function handleImport(): Promise<void> {
    if (await session.importAudio()) onClose();
  }

  const query = view.query.trim();
  const groups = groupByDay(view.items);

  return (
    <aside id="meeting-library" className="library" aria-label="会议库">
      <form className="create-meeting" onSubmit={(e) => void handleCreate(e)}>
        <label className="visually-hidden" htmlFor="meeting-title">
          会议标题
        </label>
        <input
          id="meeting-title"
          className="field"
          value={title}
          maxLength={200}
          placeholder="新会议标题"
          autoComplete="off"
          onChange={(e) => setTitle(e.target.value)}
          disabled={!actions.create}
          aria-describedby={blocked ? 'create-blocked' : undefined}
        />
        <button
          type="submit"
          className="key key-primary key-icon"
          disabled={!actions.create || !title.trim()}
          title={
            blocked
              ? savePending
                ? '录音已结束，保存完成后才能新建会议。'
                : '正在录音，停止录音后才能新建会议。'
              : `新建会议（${shortcutLabel('n')} 聚焦标题）`
          }
        >
          <Icon name="plus" />
          <span className="visually-hidden">
            {state.pending === 'create' ? '创建中...' : '新建会议'}
          </span>
        </button>
        {blocked && (
          <p id="create-blocked" className="create-blocked visually-hidden">
            {savePending
              ? '录音已结束，保存完成后才能新建会议。'
              : '正在录音，停止录音后才能新建会议。'}
          </p>
        )}
      </form>

      <div className="library-tools">
        <label className="library-search">
          <Icon name="search" />
          <input
            ref={searchRef}
            id="library-search"
            type="search"
            className="field field-bare"
            aria-label="搜索会议"
            placeholder="搜索"
            title={`搜索（${shortcutLabel('k')}）`}
            value={view.query}
            onChange={(e) => library.search(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="key key-icon key-quiet"
          title="导入音频文件"
          disabled={!manage.import}
          onClick={() => void handleImport()}
        >
          <Icon name="import" />
          <span className="visually-hidden">
            {state.pending === 'import' ? '正在导入...' : '导入音频文件'}
          </span>
        </button>
      </div>

      <div className="library-list" aria-busy={view.loadState === 'loading'}>
        {view.loadState === 'loading' && view.items.length === 0 && (
          <ol className="reel-list" aria-hidden="true">
            {[0, 1, 2].map((key) => (
              <li key={key} className="reel reel-skeleton">
                <span className="skeleton-line" />
              </li>
            ))}
          </ol>
        )}

        {view.loadState === 'error' && (
          <div className="library-message" role="alert">
            <p>{view.error ?? '会议库加载失败。'}</p>
            <button type="button" className="key" onClick={() => library.reload()}>
              <Icon name="refresh" />
              重新加载会议库
            </button>
          </div>
        )}

        {view.loadState === 'ready' && view.items.length === 0 && (
          <div className="library-message">
            {query ? <p>没有匹配「{query}」的会议。</p> : <p>还没有会议</p>}
          </div>
        )}

        {groups.map((group) => (
          <section key={group.label} className="reel-group" aria-label={group.label}>
            <h3 className="reel-day">{group.label}</h3>
            <ol className="reel-list" aria-label={query ? `搜索结果：${query}` : group.label}>
              {group.items.map((item) => {
                const current = state.meeting?.id === item.id;
                const disabled = !current && !manage.open;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="reel"
                      aria-current={current ? 'true' : undefined}
                      disabled={disabled}
                      title={disabled && blocked ? '录音中不能切换会议' : undefined}
                      onClick={() => void handleOpen(item.id)}
                    >
                      <span className={`dot dot-${STATUS_DOT[item.status]}`} aria-hidden="true" />
                      <span className="reel-title">{item.title}</span>
                      <time className="reel-time" dateTime={item.createdAt}>
                        {clock.format(new Date(item.createdAt))}
                      </time>
                      {item.snippet && (
                        <span className="reel-snippet">
                          {item.snippet.before}
                          <mark>{item.snippet.match}</mark>
                          {item.snippet.after}
                        </span>
                      )}
                      <span className="visually-hidden">{SHORT_STATUS[item.status]}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </aside>
  );
}
