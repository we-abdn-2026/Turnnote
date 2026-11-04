// 转写模型管理（运行时下载 + 镜像兜底）。
// sidecar 保持离线，只读 userData/models/<model>/；下载只发生在 Main，且只下载 model-manifest 里
// 固定 revision 的文件。流程：探测源 → 逐文件下载（Range 续传、停滞超时、换源重试）→ SHA-256 校验 →
// 整目录原子 rename 到最终位置。半截目录永远不会出现在 models/<model>/，所以 sidecar 不会误用。
// 本模块不碰数据库、不读会议数据；错误只携带稳定错误码，不含 URL、路径或响应内容。
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { open, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppError, ErrorCode, ModelStatus } from '@shared/contracts';
import type { InvokeHandlers } from '@shared/invoke';
import { errorMessages, ok, requireCondition, TurnnoteError } from '@shared/result';
import type { SafeLogger } from '../safe-logger';
import {
  DEFAULT_MODEL_SOURCES,
  MODEL_MANIFEST,
  SIDECAR_MODEL_FILES,
  modelSizeBytes,
  type ModelFile,
  type ModelManifestEntry,
} from './model-manifest';

const PARTIAL_DIR = '.partial';
/** 下载前要求在所需空间之外再留的余量，避免写满磁盘 */
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;

export interface ModelManagerOptions {
  /** userData/models */
  modelsDirectory: string;
  /** 当前使用的模型名（settings.transcriptionModel），每次调用时读取 */
  getModelName: () => string;
  emit: (status: ModelStatus) => void;
  /** false 时视为始终就绪（fake sidecar 不加载模型） */
  required?: boolean;
  sources?: readonly string[];
  manifest?: Readonly<Record<string, ModelManifestEntry>>;
  /** 测试注入；默认使用全局 fetch / fs.statfs */
  fetch?: typeof fetch;
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  /** 探测源的超时 */
  probeTimeoutMs?: number;
  /** 连接或数据流停滞多久后放弃本次尝试 */
  stallTimeoutMs?: number;
  /** 同一源的重试次数（续传）；换源前的最大尝试次数 */
  attemptsPerSource?: number;
  retryDelayMs?: number;
  logger?: SafeLogger;
}

class IntegrityError extends Error {}
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

interface Run {
  model: string;
  abort: AbortController;
  /** 每个文件已落盘的字节数，进度由它求和 */
  have: Map<string, number>;
  total: number;
  done: Promise<void>;
}

function fileSize(path: string): number {
  try {
    const info = statSync(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted');
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function failureCode(error: unknown): ErrorCode {
  return error instanceof TurnnoteError ? error.code : 'MODEL_DOWNLOAD_FAILED';
}

export function createModelManager(options: ModelManagerOptions) {
  const required = options.required ?? true;
  const manifest = options.manifest ?? MODEL_MANIFEST;
  const sources = options.sources ?? DEFAULT_MODEL_SOURCES;
  const doFetch = options.fetch ?? fetch;
  const doStatfs = options.statfs ?? ((path: string) => statfs(path));
  const probeTimeoutMs = options.probeTimeoutMs ?? 8_000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
  const attemptsPerSource = options.attemptsPerSource ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const partialRoot = join(options.modelsDirectory, PARTIAL_DIR);

  let run: Run | undefined;
  let failure: { model: string; error: AppError } | undefined;
  let lastEmit = 0;
  const readyListeners = new Set<() => void>();

  /** 与 sidecar 的加载前检查一致；清单内的模型额外要求 model.bin 大小吻合，识别被截断的文件 */
  function isInstalled(model: string): boolean {
    const dir = join(options.modelsDirectory, model);
    if (!SIDECAR_MODEL_FILES.every((name) => fileSize(join(dir, name)) > 0)) return false;
    const weights = manifest[model]?.files.find((file) => file.name === 'model.bin');
    return !weights || fileSize(join(dir, 'model.bin')) === weights.size;
  }

  function status(): ModelStatus {
    const model = options.getModelName();
    const entry = manifest[model];
    const totalBytes = entry ? modelSizeBytes(entry) : 0;
    const base = { model, totalBytes, downloadable: required && !!entry };
    if (!required || isInstalled(model)) {
      return { ...base, state: 'ready', downloadedBytes: 0, error: null };
    }
    if (run?.model === model) {
      const downloadedBytes = [...run.have.values()].reduce((sum, n) => sum + n, 0);
      return { ...base, state: 'downloading', downloadedBytes, error: null };
    }
    if (failure?.model === model) {
      return { ...base, state: 'failed', downloadedBytes: 0, error: failure.error };
    }
    return { ...base, state: 'missing', downloadedBytes: 0, error: null };
  }

  function publish(force = true): void {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    try {
      options.emit(status());
    } catch {
      /* 窗口关闭不能影响下载 */
    }
  }

  async function ensureSpace(needBytes: number): Promise<void> {
    if (needBytes <= 0) return;
    let available: number;
    try {
      const info = await doStatfs(options.modelsDirectory);
      available = info.bavail * info.bsize;
    } catch {
      return; // 无法查询时不拦截，写入失败会按下载失败处理
    }
    requireCondition(available >= needBytes + DISK_MARGIN_BYTES, 'INSUFFICIENT_DISK_SPACE');
  }

  /** 并发探测所有源，响应最快的排在最前，其余按配置顺序兜底；全部失败时仍返回配置顺序 */
  async function orderSources(entry: ModelManifestEntry, signal: AbortSignal): Promise<string[]> {
    const probeFile = entry.files[0].name;
    const fastest = await Promise.any(
      sources.map(async (source) => {
        const response = await doFetch(urlFor(source, entry, probeFile), {
          method: 'HEAD',
          signal: AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)]),
        });
        if (!response.ok) throw new HttpStatusError(response.status);
        return source;
      }),
    ).catch(() => null);
    signal.throwIfAborted();
    return fastest ? [fastest, ...sources.filter((source) => source !== fastest)] : [...sources];
  }

  function urlFor(source: string, entry: ModelManifestEntry, file: string): string {
    return `${source.replace(/\/+$/, '')}/${entry.repo}/resolve/${entry.revision}/${file}`;
  }

  /** 单次尝试：从已有字节续传到文件末尾。停滞（无数据）超时会中止本次尝试。 */
  async function transfer(
    target: string,
    file: ModelFile,
    url: string,
    current: Run,
  ): Promise<void> {
    let existing = fileSize(target);
    if (existing > file.size) {
      rmSync(target, { force: true });
      existing = 0;
    }
    current.have.set(file.name, existing);
    if (existing === file.size) return;

    const attempt = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => attempt.abort(new Error('stalled')), stallTimeoutMs);
    };
    arm();
    try {
      const response = await doFetch(url, {
        headers: existing > 0 ? { Range: `bytes=${existing}-` } : {},
        signal: AbortSignal.any([current.abort.signal, attempt.signal]),
      });
      let append = existing > 0;
      if (response.status === 206) {
        // 服务端必须从请求的偏移开始，否则拼出来的文件一定是错的
        const range = response.headers.get('content-range') ?? '';
        if (!range.startsWith(`bytes ${existing}-`)) throw new HttpStatusError(206);
      } else if (response.status === 200) {
        append = false; // 服务端忽略了 Range，整文件重来
        current.have.set(file.name, 0);
      } else {
        await response.body?.cancel().catch(() => {});
        throw new HttpStatusError(response.status);
      }
      if (!response.body) throw new Error('empty body');

      const handle = await open(target, append ? 'a' : 'w');
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          await handle.write(value);
          current.have.set(file.name, (current.have.get(file.name) ?? 0) + value.byteLength);
          publish(false);
        }
      } finally {
        await handle.close();
        await reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(watchdog);
    }
    const written = fileSize(target);
    if (written > file.size) throw new IntegrityError('too large');
    if (written < file.size) throw new Error('truncated'); // 保留已下载部分，下一次尝试续传
  }

  async function verified(target: string, file: ModelFile, signal: AbortSignal): Promise<boolean> {
    return fileSize(target) === file.size && (await sha256File(target, signal)) === file.sha256;
  }

  async function fetchFile(
    entry: ModelManifestEntry,
    partialDir: string,
    file: ModelFile,
    ordered: readonly string[],
    current: Run,
  ): Promise<void> {
    const target = join(partialDir, file.name);
    const signal = current.abort.signal;
    if (await verified(target, file, signal)) {
      current.have.set(file.name, file.size);
      return;
    }
    for (const source of ordered) {
      for (let attempt = 0; attempt < attemptsPerSource; attempt++) {
        try {
          await transfer(target, file, urlFor(source, entry, file.name), current);
          if (!(await verified(target, file, signal))) throw new IntegrityError('hash mismatch');
          current.have.set(file.name, file.size);
          return;
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          if (error instanceof IntegrityError) {
            // 内容不对：丢弃并换源，不在同一个源上重复
            rmSync(target, { force: true });
            current.have.set(file.name, 0);
            break;
          }
          // 404 等客户端错误换源也不会好转的话直接换源；网络抖动和 5xx 则原地续传重试
          if (error instanceof HttpStatusError && error.status >= 400 && error.status < 500) break;
          if (attempt + 1 < attemptsPerSource) await sleep(retryDelayMs * (attempt + 1), signal);
        }
      }
    }
    throw new TurnnoteError('MODEL_DOWNLOAD_FAILED');
  }

  /** Windows 上杀毒软件可能短暂占用刚写完的目录；有限次重试 rename */
  async function renameWithRetry(from: string, to: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
          throw error;
        await sleep(100 * (attempt + 1), signal);
      }
    }
  }

  async function execute(model: string, entry: ModelManifestEntry, current: Run): Promise<void> {
    const partialDir = join(partialRoot, `${model}@${entry.revision}`);
    mkdirSync(partialDir, { recursive: true });
    for (const file of entry.files) {
      current.have.set(file.name, Math.min(fileSize(join(partialDir, file.name)), file.size));
    }
    const have = [...current.have.values()].reduce((sum, n) => sum + n, 0);
    await ensureSpace(current.total - have);
    publish();

    const ordered = await orderSources(entry, current.abort.signal);
    for (const file of entry.files) {
      await fetchFile(entry, partialDir, file, ordered, current);
    }
    // 只有这里才会把下载内容放到 sidecar 会读取的位置。此处的目标目录只可能是上次中断留下的
    // 不完整模型（完整的会被 status 判为就绪而不会走到这里），可以安全替换。
    const finalDir = join(options.modelsDirectory, model);
    rmSync(finalDir, { recursive: true, force: true });
    await renameWithRetry(partialDir, finalDir, current.abort.signal);
    requireCondition(isInstalled(model), 'MODEL_DOWNLOAD_FAILED');
    try {
      rmdirSync(partialRoot); // 空目录才会删除
    } catch {
      /* 仍有其他模型的续传数据 */
    }
  }

  function start(model: string, entry: ModelManifestEntry): void {
    failure = undefined;
    const abort = new AbortController();
    const current: Run = {
      model,
      abort,
      have: new Map(),
      total: modelSizeBytes(entry),
      done: Promise.resolve(),
    };
    run = current;
    current.done = execute(model, entry, current).then(
      () => {
        if (run === current) run = undefined;
        publish();
        for (const listener of readyListeners) {
          try {
            listener();
          } catch {
            /* 监听者不能影响状态 */
          }
        }
      },
      (error: unknown) => {
        if (run === current) run = undefined;
        if (!abort.signal.aborted) {
          const code = failureCode(error);
          failure = { model, error: { code, message: errorMessages[code] } };
          options.logger?.error('main', 'model_download_failed', code, error);
        }
        publish();
      },
    );
    publish();
  }

  /** 清理清单中已不存在的 revision 留下的续传数据；只触碰 models/.partial 内部 */
  function removeStalePartials(): void {
    if (!existsSync(partialRoot)) return;
    const keep = new Set(
      Object.entries(manifest).map(([model, entry]) => `${model}@${entry.revision}`),
    );
    for (const name of readdirSync(partialRoot)) {
      if (!keep.has(name)) rmSync(join(partialRoot, name), { recursive: true, force: true });
    }
  }

  /** 取消下载并保留已下载部分；等待写入句柄关闭后返回 */
  async function cancel(): Promise<void> {
    const active = run;
    if (!active) return;
    active.abort.abort(new Error('cancelled'));
    await active.done;
  }

  return {
    status,
    cancel,
    isReady: () => status().state === 'ready',
    /** 当前模型状态变化（例如切换了 settings.transcriptionModel）后重新广播 */
    refresh: () => publish(),
    /** 订阅「下载完成、模型变为就绪」；返回取消订阅函数 */
    onReady(listener: () => void): () => void {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    /** 应用启动时调用：清理过期续传数据；模型缺失且可下载时自动开始下载，不阻塞调用方 */
    ensure(): void {
      if (!required) return;
      removeStalePartials();
      const model = options.getModelName();
      const entry = manifest[model];
      if (entry && status().state === 'missing') start(model, entry);
    },
    /** 用户触发（含失败后重试）。已就绪或已在下载时直接返回当前状态。 */
    download(): ModelStatus {
      const current = status();
      if (current.state === 'ready' || current.state === 'downloading') return current;
      const entry = manifest[current.model];
      requireCondition(entry, 'MODEL_NOT_READY'); // 清单外的模型只能由用户自行放置
      start(current.model, entry);
      return status();
    },
    async shutdown(): Promise<void> {
      readyListeners.clear();
      await cancel();
    },
  };
}

export type ModelManager = ReturnType<typeof createModelManager>;

export function createModelHandlers(manager: ModelManager): NonNullable<InvokeHandlers['models']> {
  return {
    getStatus: async () => ok(manager.status()),
    download: async () => ok(manager.download()),
    cancelDownload: async () => {
      await manager.cancel();
      return ok(manager.status());
    },
  };
}
