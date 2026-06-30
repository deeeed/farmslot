import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function captureHelperPath(): string {
  return resolveNativeCaptureHelperPath() ?? commandPath('capture-helper') ?? 'capture-helper';
}

function resolveNativeCaptureHelperPath(): string | null {
  const candidates = [
    process.env.CAPTURE_HELPER_PATH,
    process.env.SITEED_CAPTURE_HELPER_BIN,
    process.env.HOME
      ? join(
          process.env.HOME,
          '.npm-global/lib/node_modules/@siteed/capture-helper/native/capture-helper',
        )
      : undefined,
    npmGlobalNativePath(),
    commandNativePath(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate.endsWith('/node_modules/.bin/capture-helper')) continue;
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function npmGlobalNativePath(): string | null {
  const npm = commandPath('npm');
  if (!npm) return null;
  const result = spawnSync(npm, ['root', '-g'], { encoding: 'utf-8', timeout: 2_000 });
  const root = result.status === 0 ? result.stdout.trim() : '';
  return root ? join(root, '@siteed/capture-helper/native/capture-helper') : null;
}

function commandNativePath(): string | null {
  const bin = commandPath('capture-helper');
  if (!bin) return null;
  const real = safeRealpath(bin);
  if (!real?.endsWith('/bin/capture-helper.js')) return null;
  return join(dirname(dirname(real)), 'native/capture-helper');
}

function commandPath(command: string): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Expected for non-executable candidates while probing PATH/package locations.
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // Expected for broken symlinks or disappearing PATH entries during best-effort probing.
    return null;
  }
}
