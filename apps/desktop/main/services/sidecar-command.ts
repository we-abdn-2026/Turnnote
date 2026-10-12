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
        command: join(resourcesPath, 'asr-worker', windows ? 'asr-worker.exe' : 'asr-worker'),
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
