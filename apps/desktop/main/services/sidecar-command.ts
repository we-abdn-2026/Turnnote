import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withFakeFlag, type SidecarCommand } from './sidecar';

export interface SidecarLocation {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function packagedSidecarResource(platform: NodeJS.Platform): string {
  return `asr-worker/${platform === 'win32' ? 'asr-worker.exe' : 'asr-worker'}`;
}

export function resolvePackagedSidecarPath(
  resourcesPath: string,
  platform: NodeJS.Platform,
): string {
  return join(resourcesPath, ...packagedSidecarResource(platform).split('/'));
}

/** Paths belong to Main; neither executable nor model paths come from Renderer. */
export function resolveSidecarCommand({
  isPackaged,
  appPath,
  resourcesPath,
  platform = process.platform,
  env = process.env,
}: SidecarLocation): SidecarCommand {
  const windows = platform === 'win32';
  if (isPackaged) {
    return withFakeFlag(
      {
        command: resolvePackagedSidecarPath(resourcesPath, platform),
        args: [],
      },
      env,
    );
  }
  const venv = windows
    ? join(appPath, '.venv', 'Scripts', 'python.exe')
    : join(appPath, '.venv', 'bin', 'python');
  return withFakeFlag(
    {
      command: env.TURNNOTE_PYTHON || (existsSync(venv) ? venv : windows ? 'python' : 'python3'),
      args: [join(appPath, 'services', 'asr-worker', 'worker.py')],
    },
    env,
  );
}
