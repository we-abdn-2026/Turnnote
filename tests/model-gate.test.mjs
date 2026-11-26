/**
 * 模型闸门：模型未就绪时不启动转写（不建任务、不失败），就绪后自动补发；重启恢复同样遵守。
 * 使用真实 createSessionServices、本地模型服务器和 stub sidecar。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createModelManager } from '../out/tests/runtime.mjs';
import {
  SAMPLE_SEGMENTS,
  SAMPLE_WAV,
  createMainSession,
  delay,
  failure,
  succeedingSidecar,
  until,
  value,
} from './support/main-session.mjs';
import { fakeModel, startModelServer } from './support/model-server.mjs';

/** 默认设置的模型名是 small；把假模型登记为 small */
async function modelEnv(t, { installed = false } = {}) {
  const { files, manifestEntry } = fakeModel({ weightsBytes: 60_000 });
  const server = await startModelServer(t, files, { bodyDelayMs: 30 });
  const statuses = [];
  const factory = ({ root, store }) =>
    createModelManager({
      modelsDirectory: join(root, 'models'),
      getModelName: () => store.getSettings().transcriptionModel,
      emit: (status) => statuses.push(structuredClone(status)),
      manifest: { small: manifestEntry },
      sources: [server.url],
      retryDelayMs: 5,
      probeTimeoutMs: 500,
    });
  const install = (root) => {
    const dir = join(root, 'models', 'small');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of files) writeFileSync(join(dir, name), content);
  };
  return { files, server, statuses, factory, install, installed };
}

const record = async (env, title = 'Gated meeting') => {
  const meeting = value(await env.api.meetings.create(title));
  const started = value(await env.api.recording.start(meeting.id));
  value(
    await env.api.recording.appendChunk(
      meeting.id,
      started.activeJobId,
      Int16Array.from({ length: 1600 }, (_, i) => (i * 7) % 900),
    ),
  );
  value(await env.api.recording.stop(meeting.id, started.activeJobId));
  return meeting.id;
};

test('without the model a recording stays captured: no job, no sidecar, no failure; the download then transcribes it', async (t) => {
  const model = await modelEnv(t);
  let spawned = 0;
  const env = await createMainSession(t, {
    models: model.factory,
    sidecar: () => {
      spawned++;
      return succeedingSidecar();
    },
  });
  const id = await record(env);
  await delay(150);
  assert.equal(env.status(id), 'captured');
  assert.equal(env.store.getJobs(id).filter((job) => job.kind === 'transcribing').length, 0);
  assert.equal(spawned, 0);
  assert.equal(env.store.get(id).hasAudio, true, 'audio is kept while waiting for the model');

  // 手动开始会得到明确的错误，而不是进入 failed
  failure(await env.api.transcription.start(id), 'MODEL_NOT_READY');
  assert.equal(env.status(id), 'captured');
  assert.equal(env.store.getJobs(id).length, 1, 'only the recording job exists');

  // 下载完成后自动补发转写
  assert.equal(value(await env.api.models.download()).state, 'downloading');
  await until(() => env.status(id) === 'transcribed', 'auto transcription after download', 10_000);
  assert.deepEqual(env.store.getSegments(id), SAMPLE_SEGMENTS);
  assert.equal(spawned, 1);
  assert.equal(value(await env.api.models.getStatus()).state, 'ready');
});

test('only never-attempted meetings are resumed; a transcription the user cancelled stays cancelled', async (t) => {
  const model = await modelEnv(t);
  const env = await createMainSession(t, {
    models: model.factory,
    sidecar: () => succeedingSidecar(),
  });
  const fresh = env.captured('Never attempted', SAMPLE_WAV).id;
  const cancelled = env.captured('Cancelled by user', SAMPLE_WAV).id;
  const job = env.store.beginTranscription(cancelled);
  env.store.cancelTranscription(cancelled, job.id);
  assert.equal(env.status(cancelled), 'captured');

  value(await env.api.models.download());
  await until(() => env.status(fresh) === 'transcribed', 'fresh meeting resumed', 10_000);
  await delay(100);
  assert.equal(env.status(cancelled), 'captured');
  assert.equal(env.store.getJobs(cancelled).filter((j) => j.kind === 'transcribing').length, 1);
});

test('after a restart with the model present, meetings left captured are transcribed on recovery', async (t) => {
  const model = await modelEnv(t);
  const env = await createMainSession(t, {
    models: model.factory,
    sidecar: () => succeedingSidecar(),
  });
  const id = env.captured('Waited for model', SAMPLE_WAV).id;
  await delay(50);
  assert.equal(env.status(id), 'captured');

  model.install(env.root); // 用户在下次启动前准备好了模型
  const restarted = await env.reopen({ models: model.factory, sidecar: () => succeedingSidecar() });
  await until(() => restarted.status(id) === 'transcribed', 'resumed by recover', 10_000);
});

test('after a restart without the model nothing starts and nothing is downloaded until ensure() is called', async (t) => {
  const model = await modelEnv(t);
  let spawned = 0;
  const env = await createMainSession(t, {
    models: model.factory,
    sidecar: () => succeedingSidecar(),
  });
  const id = env.captured('Still waiting', SAMPLE_WAV).id;
  const restarted = await env.reopen({
    models: model.factory,
    sidecar: () => {
      spawned++;
      return succeedingSidecar();
    },
  });
  await delay(150);
  assert.equal(restarted.status(id), 'captured');
  assert.equal(spawned, 0);
  assert.equal(model.server.hits.length, 0, 'recovery alone never touches the network');

  restarted.models.ensure(); // 与 Main 启动时的调用一致
  await until(() => restarted.status(id) === 'transcribed', 'auto after ensure', 10_000);
});

test('changing the transcription model re-broadcasts the status for the new model', async (t) => {
  const model = await modelEnv(t);
  const env = await createMainSession(t, { models: model.factory });
  assert.equal(value(await env.api.models.getStatus()).model, 'small');
  const before = model.statuses.length;
  value(await env.api.settings.update({ transcriptionModel: 'base' }));
  const latest = model.statuses.at(-1);
  assert.ok(model.statuses.length > before);
  assert.deepEqual([latest.model, latest.state, latest.downloadable], ['base', 'missing', false]);
  // 非模型设置不触发广播
  const count = model.statuses.length;
  value(await env.api.settings.update({ includeSystemAudio: false }));
  assert.equal(model.statuses.length, count);
});

test('without a model manager the models API is not implemented and transcription is not gated', async (t) => {
  const env = await createMainSession(t, { sidecar: () => succeedingSidecar() });
  failure(await env.api.models.getStatus(), 'NOT_IMPLEMENTED');
  const id = env.captured('Ungated', SAMPLE_WAV).id;
  value(await env.api.transcription.start(id));
  await until(() => env.status(id) === 'transcribed');
});
