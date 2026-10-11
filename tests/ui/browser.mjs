// 在真实浏览器中驱动 dev:web：启动 Vite（与 `npm run dev:web` 相同配置），
// 用 Chrome DevTools Protocol 控制本机 Chrome。只用 Node 内置 WebSocket，不新增依赖。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadConfigFromFile } from 'vite';

const PAGE_SCRIPT = readFileSync(new URL('./page.js', import.meta.url), 'utf8');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  const path = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
  if (!path) throw new Error('Chrome not found. Install Chrome or set CHROME_PATH.');
  return path;
}

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'turnnote-ui-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    let output = '';
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code})`));
    });
  });
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  // 等 Chrome 退出后再删配置目录，否则 Chrome 仍在写入，删除会失败
  const close = async () => {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill();
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { ready, close };
}

class Page {
  #ws;
  #nextId = 1;
  #pending = new Map();
  errors = [];

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** 在页面中执行表达式，返回可序列化的结果；页面内异常会让测试失败 */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  async waitFor(expression, { timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  close() {
    this.#ws.close();
  }
}

/** 启动 dev:web 和 Chrome；open() 每次打开一个全新的页面 */
export async function startBrowser() {
  // 与 `npm run dev:web` 使用同一份配置（mode: mock）
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'mock' },
    'vite.renderer.config.ts',
  );
  const server = await createServer({
    ...loaded.config,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const chrome = launchChrome();
  let browserWs;
  try {
    browserWs = await chrome.ready;
  } catch (error) {
    await Promise.allSettled([server.close(), chrome.close()]);
    throw error;
  }
  const devtools = `http://${new URL(browserWs).host}`;
  const pages = [];

  return {
    async open() {
      const target = await (
        await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })
      ).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const page = new Page(ws);
      pages.push(page);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT });
      await page.send('Page.navigate', { url });
      await page.waitFor(
        'window.__ui?.api && !!document.querySelector("[aria-label=录音工作区]")',
        {
          timeout: 15000,
        },
      );
      return page;
    },
    // 任一步失败也要完成其余清理，避免残留的 Vite 服务让测试进程无法退出
    async close() {
      for (const page of pages) page.close();
      const results = await Promise.allSettled([chrome.close(), server.close()]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
