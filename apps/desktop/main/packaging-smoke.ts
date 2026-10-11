import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface SmokeResult {
  checkedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  sqlite: 'ok' | 'failed';
  sidecar: 'ok' | 'failed';
  sidecarPath: string;
  error?: string;
}

function checkSqlite(): void {
  const database = new Database(':memory:');
  try {
    const row = database.prepare('SELECT 1 AS value').get() as { value: number };
    if (row.value !== 1) throw new Error('SQLite returned an unexpected result.');
  } finally {
    database.close();
  }
}

function checkSidecar(sidecarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sidecarPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(
      () => finish(new Error(`Sidecar ping timed out. ${stderr.trim()}`.trim())),
      10_000,
    );

    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>;
        if (response.id === 'packaging-smoke' && response.type === 'pong') finish();
        else finish(new Error('Sidecar returned an unexpected ping response.'));
      } catch {
        finish(new Error('Sidecar returned invalid JSON.'));
      }
    });
    child.stdin.write('{"id":"packaging-smoke","type":"ping"}\n');
  });
}

export async function runPackagingSmoke(
  resourcesPath: string,
  userDataPath: string,
  forceFailure = false,
): Promise<{ passed: boolean; logPath: string }> {
  const sidecarPath = join(
    resourcesPath,
    'asr-worker',
    process.platform === 'win32' ? 'asr-worker.exe' : 'asr-worker',
  );
  const result: SmokeResult = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    sqlite: 'failed',
    sidecar: 'failed',
    sidecarPath,
  };

  try {
    if (forceFailure) throw new Error('Intentional packaging smoke-test failure.');
    checkSqlite();
    result.sqlite = 'ok';
    await checkSidecar(sidecarPath);
    result.sidecar = 'ok';
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  mkdirSync(userDataPath, { recursive: true });
  const logPath = join(userDataPath, 'packaging-validation.json');
  writeFileSync(logPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { passed: result.sqlite === 'ok' && result.sidecar === 'ok', logPath };
}
