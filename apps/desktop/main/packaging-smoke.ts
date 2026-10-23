import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SidecarCommand } from './services/sidecar';
import { packagedSidecarResource, resolvePackagedSidecarPath } from './services/sidecar-command';

interface SmokeResult {
  checkedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  electronVersion: string;
  modulesAbi: string;
  sqlite: 'ok' | 'failed';
  sidecar: 'ok' | 'failed';
  sidecarResource: string;
  errorCode?: 'SQLITE_CHECK_FAILED' | 'SIDECAR_CHECK_FAILED';
}

interface PackagingChecks {
  sqlite: () => void;
  sidecar: (command: SidecarCommand) => Promise<void>;
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

/** A ping only passes after its child has actually released all resources. */
export function checkPackagedSidecar(command: SidecarCommand, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let outputBytes = 0;
    let outcome: { error?: Error } | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error): void => {
      if (outcome) return;
      outcome = { error };
      clearTimeout(timer);
      child.kill();
      // A misbehaving worker must not keep the installation probe alive.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
    };
    const timer = setTimeout(() => finish(new Error('Sidecar ping timed out.')), timeoutMs);
    child.on('error', () => finish(new Error('Sidecar could not start.')));
    child.stdin.on('error', () => finish(new Error('Sidecar input closed before pong.')));
    child.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const error = outcome ? outcome.error : new Error('Sidecar exited before pong.');
      if (error) reject(error);
      else resolve();
    });
    const limitOutput = (chunk: Buffer): boolean => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) finish(new Error('Sidecar ping output exceeded its limit.'));
      return !outcome;
    };
    child.stderr.on('data', (chunk: Buffer) => {
      limitOutput(chunk);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!limitOutput(chunk)) return;
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(stdout.slice(0, newline));
        if (
          response &&
          typeof response === 'object' &&
          'id' in response &&
          response.id === 'packaging-smoke' &&
          'type' in response &&
          response.type === 'pong' &&
          'status' in response &&
          response.status === 'ok'
        )
          finish();
        else finish(new Error('Sidecar returned an unexpected ping response.'));
      } catch {
        finish(new Error('Sidecar returned invalid JSON.'));
      }
    });
    child.stdin.end('{"id":"packaging-smoke","type":"ping"}\n');
  });
}

export async function runPackagingSmoke(
  resourcesPath: string,
  userDataPath: string,
  checks: PackagingChecks = { sqlite: checkSqlite, sidecar: checkPackagedSidecar },
): Promise<{ passed: boolean; logPath: string }> {
  const sidecarPath = resolvePackagedSidecarPath(resourcesPath, process.platform);
  const result: SmokeResult = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    modulesAbi: process.versions.modules,
    sqlite: 'failed',
    sidecar: 'failed',
    sidecarResource: packagedSidecarResource(process.platform),
  };

  try {
    checks.sqlite();
    result.sqlite = 'ok';
  } catch {
    result.errorCode = 'SQLITE_CHECK_FAILED';
  }
  if (result.sqlite === 'ok') {
    try {
      await checks.sidecar({ command: sidecarPath, args: [] });
      result.sidecar = 'ok';
    } catch {
      result.errorCode = 'SIDECAR_CHECK_FAILED';
    }
  }

  mkdirSync(userDataPath, { recursive: true });
  const logPath = join(userDataPath, 'packaging-validation.json');
  writeFileSync(logPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { passed: result.sqlite === 'ok' && result.sidecar === 'ok', logPath };
}
