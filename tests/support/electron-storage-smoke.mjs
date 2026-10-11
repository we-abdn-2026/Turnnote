import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore } from '../../out/tests/runtime.mjs';

assert.ok(process.versions.electron, 'Smoke must run under the Electron Node runtime.');
const directory = mkdtempSync(join(tmpdir(), 'turnnote-electron-storage-'));
let store;
try {
  const databasePath = join(directory, 'meeting.db');
  const audioDirectory = join(directory, 'audio');
  store = new MeetingStore(databasePath, audioDirectory);
  const meeting = store.create('Electron native SQLite smoke');
  store.updateSettings({ transcriptionLanguage: 'zh' });
  store.close();
  store = undefined;
  store = new MeetingStore(databasePath, audioDirectory);
  assert.equal(store.get(meeting.id).title, meeting.title);
  assert.equal(store.getSettings().transcriptionLanguage, 'zh');
  console.log(
    `Electron ${process.versions.electron} / Node ${process.versions.node}: SQLite load, migration and persistence passed.`,
  );
} finally {
  store?.close();
  rmSync(directory, { recursive: true, force: true });
}
