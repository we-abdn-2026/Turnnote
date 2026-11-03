// 会议库列表：数据只来自 Main 的 meetings.list，任何会议更新事件都触发一次合并刷新。
// 搜索按请求序号只接受最后一次结果，慢请求不会覆盖新的查询。不依赖 React。
import type { MeetingSummary, Result, TurnnoteApi } from '@shared/contracts';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';

export type LibraryLoadState = 'loading' | 'ready' | 'error';

/** 搜索命中转写正文时，显示命中处前后的一小段原话 */
export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface LibraryItem extends MeetingSummary {
  snippet?: Snippet;
}

export interface LibraryState {
  items: LibraryItem[];
  query: string;
  loadState: LibraryLoadState;
  error: string | null;
}

export interface MeetingLibrary {
  getState(): LibraryState;
  subscribe(listener: () => void): () => void;
  /** 开始加载并在事件到达时刷新；返回的函数停止刷新并使未完成请求失效 */
  connect(watch: (listener: () => void) => () => void): () => void;
  search(query: string): void;
  reload(): void;
}

const REFRESH_DELAY_MS = 120;
/** 只为前几条结果读取转写来生成片段，避免一次搜索读完整个会议库 */
const SNIPPET_LIMIT = 20;
const CONTEXT = 18;

function findSnippet(text: string, query: string): Snippet | undefined {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return undefined;
  const flat = (value: string): string => value.replace(/\s+/g, ' ');
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(text.length, at + query.length + CONTEXT);
  return {
    before: (start > 0 ? '…' : '') + flat(text.slice(start, at)),
    match: text.slice(at, at + query.length),
    after: flat(text.slice(at + query.length, end)) + (end < text.length ? '…' : ''),
  };
}

export function createMeetingLibrary(
  api: Pick<TurnnoteApi, 'meetings' | 'transcription'>,
): MeetingLibrary {
  let state: LibraryState = { items: [], query: '', loadState: 'loading', error: null };
  const listeners = new Set<() => void>();
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;

  function set(patch: Partial<LibraryState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    const id = ++request;
    const query = state.query.trim();
    let result: Result<MeetingSummary[]> | null;
    try {
      result = await api.meetings.list(query || undefined);
    } catch {
      result = null;
    }
    if (!connected || id !== request) return;
    if (!result || !result.ok) {
      set({
        loadState: 'error',
        error: result ? describeError(result.error) : REQUEST_FAILED_MESSAGE,
      });
      return;
    }
    set({ items: result.value, loadState: 'ready', error: null });
    if (query) void attachSnippets(id, query, result.value);
  }

  async function attachSnippets(id: number, query: string, items: MeetingSummary[]): Promise<void> {
    const candidates = items
      .filter((item) => !item.title.toLowerCase().includes(query.toLowerCase()))
      .slice(0, SNIPPET_LIMIT);
    const found = await Promise.all(
      candidates.map(async (item) => {
        try {
          const result = await api.transcription.getSegments(item.id);
          if (!result.ok) return [item.id, undefined] as const;
          const hit = result.value.find((segment) =>
            segment.text.toLowerCase().includes(query.toLowerCase()),
          );
          return [item.id, hit ? findSnippet(hit.text, query) : undefined] as const;
        } catch {
          return [item.id, undefined] as const;
        }
      }),
    );
    // 期间有更新的请求或查询时，这批片段已过期
    if (!connected || id !== request) return;
    const snippets = new Map(found);
    set({ items: state.items.map((item) => ({ ...item, snippet: snippets.get(item.id) })) });
  }

  function schedule(delay = REFRESH_DELAY_MS): void {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), delay);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect(watch) {
      connected = true;
      const unwatch = watch(() => schedule());
      void load();
      return () => {
        connected = false;
        request += 1;
        clearTimeout(timer);
        unwatch();
      };
    },
    search(query) {
      if (query === state.query) return;
      // 旧查询的片段不再适用，立即清掉，不等防抖后的刷新
      set({ query, items: state.items.map(({ snippet: _snippet, ...item }) => item) });
      schedule(180);
    },
    reload() {
      set({ loadState: 'loading', error: null });
      void load();
    },
  };
}
