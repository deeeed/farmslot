import { accessSync, constants } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { NativeWorkerFilesystemPolicy } from './worker-launch.js';

export interface NativeProcessSandbox {
  executable: string;
  args: string[];
}

export function hostReviewSandboxAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    accessSync('/usr/bin/sandbox-exec', constants.X_OK);
    return true;
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** Protect source independently of a runner's trust prompts and tool approval settings. */
export async function reviewProcessSandbox(
  policy: NativeWorkerFilesystemPolicy,
  runtimeRoots: string[],
): Promise<{ sandbox: NativeProcessSandbox; temporaryDirectory: string }> {
  if (!hostReviewSandboxAvailable())
    throw new Error('This runner needs the macOS review sandbox on its execution node');
  const temporaryDirectory = join(policy.writableRoots[0], '.review-runtime', 'tmp');
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const writable = await Promise.all(policy.writableRoots.map((root) => realpath(root)));
  const readOnly = await Promise.all(policy.readOnlyRoots.map((root) => realpath(root)));
  // Native CLIs persist their own conversation/account state outside the report directory.
  for (const root of runtimeRoots) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    writable.push(await realpath(root));
  }
  const quote = (value: string) => JSON.stringify(value);
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((root) => `(allow file-write* (subpath ${quote(root)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    ...readOnly.map((root) => `(deny file-write* (subpath ${quote(root)}))`),
  ].join('\n');
  return {
    sandbox: { executable: '/usr/bin/sandbox-exec', args: ['-p', profile] },
    temporaryDirectory,
  };
}
