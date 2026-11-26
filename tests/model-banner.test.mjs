import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMockApi,
  deriveModelBanner,
  describeCode,
  errorMessages,
  formatBytes,
} from '../out/tests/runtime.mjs';

const status = (patch) => ({
  model: 'small',
  state: 'missing',
  totalBytes: 483_546_902,
  downloadedBytes: 0,
  downloadable: true,
  error: null,
  ...patch,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 500; i++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail('state not reached');
}

test('a ready or unknown model shows nothing', () => {
  assert.equal(deriveModelBanner(null), null);
  assert.equal(deriveModelBanner(status({ state: 'ready' })), null);
});

test('missing model offers a download and says audio stays on this computer', () => {
  const view = deriveModelBanner(status());
  assert.equal(view.tone, 'info');
  assert.deepEqual(view.action, { kind: 'download', label: '下载' });
  assert.match(view.detail, /484 MB/);
  assert.match(view.detail, /不会离开这台电脑/);
  assert.equal(view.progress, null);
});

test('downloading shows bounded progress, size and a cancel action', () => {
  const half = deriveModelBanner(status({ state: 'downloading', downloadedBytes: 241_773_451 }));
  assert.equal(half.progress, 0.5);
  assert.match(half.detail, /50% · 242 MB \/ 484 MB/);
  assert.deepEqual(half.action, { kind: 'cancel', label: '取消' });
  assert.match(half.detail, /自动开始转写/);
  // 异常数据不会让进度条越界或出现 NaN
  assert.equal(
    deriveModelBanner(status({ state: 'downloading', downloadedBytes: 9e12 })).progress,
    1,
  );
  assert.equal(deriveModelBanner(status({ state: 'downloading', totalBytes: 0 })).progress, 0);
});

test('failures use the shared Chinese copy per error code and offer a retry', () => {
  for (const code of ['MODEL_DOWNLOAD_FAILED', 'INSUFFICIENT_DISK_SPACE']) {
    const view = deriveModelBanner(
      status({ state: 'failed', error: { code, message: errorMessages[code] } }),
    );
    assert.equal(view.tone, 'error');
    assert.equal(view.detail, describeCode(code));
    assert.deepEqual(view.action, { kind: 'download', label: '重试' });
  }
  assert.notEqual(describeCode('INSUFFICIENT_DISK_SPACE'), describeCode('MODEL_DOWNLOAD_FAILED'));
});

test('a model outside the manifest explains what to do and offers no download', () => {
  const view = deriveModelBanner(status({ downloadable: false, totalBytes: 0 }));
  assert.equal(view.tone, 'error');
  assert.equal(view.action, null);
  assert.match(view.detail, /models/);
});

test('byte formatting uses decimal units and no fractional megabytes', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(2_370), '0 MB');
  assert.equal(formatBytes(483_546_902), '484 MB');
  assert.equal(formatBytes(1_500_000_000), '1.5 GB');
});

test('mock API defaults to a ready model so existing flows are unaffected', async () => {
  const api = createMockApi({ seed: false, delayMs: 1 });
  assert.equal((await api.models.getStatus()).value.state, 'ready');
});

test('mock API gates transcription, simulates the download and resumes captured meetings', async () => {
  const api = createMockApi({ seed: false, delayMs: 1, model: 'missing' });
  const seen = [];
  const off = api.events.onModelStatus((next) => seen.push(next.state));
  assert.equal((await api.models.getStatus()).value.state, 'missing');

  const imported = (await api.meetings.importAudio()).value;
  await delay(30);
  assert.equal((await api.meetings.get(imported.id)).value.status, 'captured');
  assert.equal((await api.transcription.start(imported.id)).error.code, 'MODEL_NOT_READY');

  assert.equal((await api.models.download()).value.state, 'downloading');
  await until(() => seen.includes('ready'));
  assert.equal(seen[0], 'downloading');
  for (let i = 0; i < 400; i++) {
    if ((await api.meetings.get(imported.id)).value.status === 'transcribed') break;
    await delay(5);
  }
  assert.equal((await api.meetings.get(imported.id)).value.status, 'transcribed');
  off();
});

test('mock API cancel returns to missing and a second download request joins the first', async () => {
  const api = createMockApi({ seed: false, delayMs: 30, model: 'missing' });
  await api.models.download();
  assert.equal((await api.models.download()).value.state, 'downloading');
  const cancelled = await api.models.cancelDownload();
  assert.deepEqual([cancelled.value.state, cancelled.value.downloadedBytes], ['missing', 0]);
});
