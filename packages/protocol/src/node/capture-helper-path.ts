import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where a resolved capture-helper binary came from, for provenance reporting. */
export type CaptureHelperSource =
  | 'env:CAPTURE_HELPER_PATH'
  | 'env:SITEED_CAPTURE_HELPER_BIN'
  | 'npm-global'
  | 'npm-root'
  | 'PATH'
  | 'fallback';

export interface CaptureHelperPathInfo {
  path: string;
  source: CaptureHelperSource;
}

export function captureHelperPath(): string {
  return captureHelperPathInfo().path;
}

export function captureHelperPathInfo(): CaptureHelperPathInfo {
  const native = resolveNativeCaptureHelperPathInfo();
  if (native) return native;
  const onPath = commandPath('capture-helper');
  if (onPath) return { path: onPath, source: 'PATH' };
  return { path: 'capture-helper', source: 'fallback' };
}

export function resolveNativeCaptureHelperPath(): string | null {
  return resolveNativeCaptureHelperPathInfo()?.path ?? null;
}

function resolveNativeCaptureHelperPathInfo(): CaptureHelperPathInfo | null {
  const candidates: { path: string | null | undefined; source: CaptureHelperSource }[] = [
    { path: process.env.CAPTURE_HELPER_PATH, source: 'env:CAPTURE_HELPER_PATH' },
    { path: process.env.SITEED_CAPTURE_HELPER_BIN, source: 'env:SITEED_CAPTURE_HELPER_BIN' },
    {
      path: process.env.HOME
        ? join(
            process.env.HOME,
            '.npm-global/lib/node_modules/@siteed/capture-helper/native/capture-helper',
          )
        : undefined,
      source: 'npm-global',
    },
    { path: npmGlobalNativePath(), source: 'npm-root' },
    { path: commandPath('capture-helper'), source: 'PATH' },
  ];

  for (const { path, source } of candidates) {
    if (!path) continue;
    const native = nativePathForWrapper(path);
    if (native && isExecutable(native)) return { path: native, source };
    if (!isWrapperShim(path) && isExecutable(path)) return { path, source };
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

function nativePathForWrapper(path: string): string | null {
  const real = safeRealpath(path);
  if (!real?.endsWith('/bin/capture-helper.js')) return null;
  return join(dirname(dirname(real)), 'native/capture-helper');
}

function isWrapperShim(path: string): boolean {
  if (path.endsWith('/node_modules/.bin/capture-helper')) return true;
  return safeRealpath(path)?.endsWith('/bin/capture-helper.js') ?? false;
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
