/**
 * 本地模拟 Hugging Face 的 `resolve` 端点，用于模型下载测试。
 * 路径：/<repo>/resolve/<revision>/<file>；支持 HEAD、Range，并可注入各种故障。
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** 确定性的伪随机内容，便于断言 */
export function bytes(length, seed = 7) {
  const out = Buffer.alloc(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

/** 一个小型假模型：与真实清单同样的四个文件，model.bin 足够大以便中途断流 */
export function fakeModel({ weightsBytes = 300_000, seed = 7 } = {}) {
  const files = new Map([
    ['config.json', Buffer.from('{"fake":true}')],
    ['tokenizer.json', bytes(2_000, seed + 1)],
    ['vocabulary.txt', bytes(500, seed + 2)],
    ['model.bin', bytes(weightsBytes, seed + 3)],
  ]);
  const manifestEntry = {
    repo: 'test-org/fake-model',
    revision: 'a'.repeat(40),
    files: [...files].map(([name, buffer]) => ({
      name,
      size: buffer.length,
      sha256: sha256(buffer),
    })),
  };
  return { files, manifestEntry };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Map<string, Buffer>} files
 * @param {{
 *   status?: number,                 // 对所有请求返回该状态
 *   headDelayMs?: number,            // HEAD（探测）延迟
 *   ignoreRange?: boolean,           // 忽略 Range，总是 200 整文件
 *   corrupt?: Set<string>,           // 这些文件内容被翻转一个字节
 *   cutOnce?: { name: string, after: number },  // 第一次请求该文件时发送 after 字节后断开连接
 *   stall?: string,                  // 该文件发送少量字节后不再发送
 *   bodyDelayMs?: number,            // 每个 GET 响应开始前的延迟
 * }} [behavior]
 */
export async function startModelServer(t, files, behavior = {}) {
  const hits = [];
  let cutDone = false;
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const match = /^\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(req.url.split('?')[0]);
    const range = req.headers.range ?? null;
    const name = match?.[3];
    hits.push({ method: req.method, name, range });
    if (behavior.status) {
      res.writeHead(behavior.status).end();
      return;
    }
    if (!match || !files.has(name)) {
      res.writeHead(404).end();
      return;
    }
    let body = files.get(name);
    if (behavior.corrupt?.has(name)) {
      body = Buffer.from(body);
      body[Math.floor(body.length / 2)] ^= 0xff;
    }
    if (req.method === 'HEAD') {
      if (behavior.headDelayMs) await new Promise((r) => setTimeout(r, behavior.headDelayMs));
      res.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes' }).end();
      return;
    }
    if (behavior.bodyDelayMs) await new Promise((r) => setTimeout(r, behavior.bodyDelayMs));
    let start = 0;
    const requested = !behavior.ignoreRange && range ? /^bytes=(\d+)-$/.exec(range) : null;
    if (requested) start = Number(requested[1]);
    const slice = body.subarray(start);
    const headers = {
      'content-length': slice.length,
      'accept-ranges': 'bytes',
      ...(requested ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    };
    res.writeHead(requested ? 206 : 200, headers);
    if (behavior.stall === name) {
      res.write(slice.subarray(0, Math.min(16, slice.length)));
      return; // 之后不再发送，也不结束
    }
    if (behavior.cutOnce?.name === name && !cutDone) {
      cutDone = true;
      res.write(slice.subarray(0, behavior.cutOnce.after));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(slice);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    /** 只看 GET 文件请求（排除 HEAD 探测） */
    gets: (name) => hits.filter((hit) => hit.method === 'GET' && (!name || hit.name === name)),
  };
}

/** 一个肯定连不上的源（端口关闭） */
export async function deadSource() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  server.close();
  await once(server, 'close');
  return url;
}
