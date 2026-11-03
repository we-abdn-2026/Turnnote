// 会议库列表：数据只来自 Main 的 meetings.list，任何会议更新事件都触发一次合并刷新。
// 搜索按请求序号只接受最后一次结果，慢请求不会覆盖新的查询。不依赖 React。
import type { MeetingSummary, Result, TurnnoteApi } from '@shared/contracts';
import { REQUEST_FAILED_MESSAGE, describeError } from '../ui/errors';

export type LibraryLoadState = 'loading' | 'ready' | 'error';

export interface LibraryState {
  items: MeetingSummary[];
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

export function createMeetingLibrary(api: Pick<TurnnoteApi, 'meetings'>): MeetingLibrary {
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
      set({ query });
      schedule(180);
    },
    reload() {
      set({ loadState: 'loading', error: null });
      void load();
    },
  };
}
