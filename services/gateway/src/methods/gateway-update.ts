import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { watch } from 'chokidar';

import type { CheckoutUpdateOperation, GatewayUpdateParams } from '@farmslot/protocol';

import { farmslotRoot } from '../core/index.js';

const exec = promisify(execFile);
async function recordPath(root = farmslotRoot): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['rev-parse', '--git-path', 'farmslot-checkout-update.json'],
    { cwd: root, timeout: 8000 },
  );
  return resolve(root, stdout.trim());
}

async function writeOperation(path: string, operation: CheckoutUpdateOperation): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(operation), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export type CheckoutObservationChange = 'operation' | 'checkout';

/** `file` is `directory` or below it. */
function within(file: string, directory: string): boolean {
  const path = relative(directory, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}

/** The nearest directory above `file` that exists now. */
function existingDirectoryAbove(file: string): string {
  let directory = dirname(file);
  while (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directory;
}

/** Atomic worker records and Git refs own progress; viewers never sample them on a timer. */
export async function watchCheckoutUpdateChanges(
  changed: (kind: CheckoutObservationChange) => void,
  failed: (error: unknown) => void,
  root = farmslotRoot,
): Promise<() => Promise<void>> {
  const versionFiles = [
    resolve(root, 'services/gateway/package.json'),
    resolve(root, 'services/gateway/release-notes.json'),
  ];
  let operationFile: string | undefined;
  const paths = [...versionFiles];
  const refDirectories: string[] = [];
  try {
    operationFile = await recordPath(root);
  } catch (error) {
    // A packaged gateway outside Git still observes its version; the source reports unavailability.
    failed(error);
  }
  if (operationFile) {
    paths.push(operationFile);
    for (const name of ['HEAD', 'refs/heads', 'refs/remotes', 'packed-refs']) {
      const { stdout } = await exec('git', ['rev-parse', '--git-path', name], {
        cwd: root,
        timeout: 8000,
      });
      const path = resolve(root, stdout.trim());
      paths.push(path);
      if (name.startsWith('refs/')) refDirectories.push(path);
    }
  }
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogVersion = 0;
  const armWatchdog = async (afterDeadline = false): Promise<void> => {
    const version = ++watchdogVersion;
    clearTimeout(watchdog);
    if (!operationFile || stopped) return;
    let operation: CheckoutUpdateOperation;
    try {
      operation = JSON.parse(await readFile(operationFile, 'utf8')) as CheckoutUpdateOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stopped || version !== watchdogVersion || operation.phase !== 'running') return;
    const untilDeadline = Date.parse(operation.updatedAt) + 120_001 - Date.now();
    if (!Number.isFinite(untilDeadline)) throw new Error('Invalid checkout operation deadline');
    watchdog = setTimeout(
      () => {
        if (stopped) return;
        changed('operation');
        // A worker still alive after its deadline is checked by this service, never each viewer.
        void armWatchdog(true).catch(failed);
      },
      Math.max(afterDeadline ? 120_000 : 1, untilDeadline),
    );
    watchdog.unref();
  };
  // A missing path gets chokidar's fallback directory watch only after `ready`, so on Linux a record
  // written right after start went unseen; missing files in one directory also share one throttled
  // read, so one of them could go unseen at all. Watch the nearest existing directories instead
  // and admit only the observed paths and the directories leading to them.
  const selected = (file: string) =>
    paths.some((path) => within(path, file)) ||
    refDirectories.some((directory) => within(file, directory));
  const roots = [...new Set(paths.map(existingDirectoryAbove))];
  const watcher = watch(
    roots.filter(
      (directory) => !roots.some((other) => other !== directory && within(directory, other)),
    ),
    { ignoreInitial: true, ignored: (file) => !selected(file) },
  );
  watcher.on('all', (event, file) => {
    if (stopped || !['add', 'change', 'unlink'].includes(event)) return;
    if (operationFile && resolve(file) === operationFile) {
      changed('operation');
      void armWatchdog().catch(failed);
    } else changed('checkout');
  });
  watcher.on('error', failed);
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', resolve);
      watcher.once('error', reject);
    });
    await armWatchdog();
  } catch (error) {
    stopped = true;
    watchdogVersion++;
    clearTimeout(watchdog);
    await watcher.close();
    throw error;
  }
  return async () => {
    stopped = true;
    watchdogVersion++;
    clearTimeout(watchdog);
    await watcher.close();
  };
}

export async function readCheckoutUpdate(
  root = farmslotRoot,
): Promise<CheckoutUpdateOperation | undefined> {
  let path: string;
  try {
    path = await recordPath(root);
  } catch {
    // Packaged deployments outside Git cannot have a checkout update operation.
    return undefined;
  }
  let operation: CheckoutUpdateOperation;
  try {
    operation = JSON.parse(await readFile(path, 'utf8')) as CheckoutUpdateOperation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (operation.phase === 'running' && Date.now() - Date.parse(operation.updatedAt) > 120_000) {
    // Every Git command has a 30-second deadline. A dead worker must not leave
    // the UI claiming an update is still running after a crash or machine reboot.
    let alive = false;
    if (operation.pid) {
      try {
        process.kill(operation.pid, 0);
        alive = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!alive) {
      operation = {
        ...operation,
        phase: 'error',
        message: 'The update worker stopped. Refresh the checkout status before retrying.',
      };
      await writeOperation(path, operation);
      await rm(`${path}.lock`, { recursive: true, force: true });
    }
  }
  if (operation.phase !== 'running') {
    // A finished record describes one commit: the target once complete, the
    // untouched local commit after an error. When HEAD moved on by any route
    // (a terminal pull, another update), it no longer describes this checkout.
    const describes = operation.phase === 'complete' ? operation.targetSha : operation.localSha;
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 8000 }).then(
      ({ stdout }) => stdout.trim(),
      () => '',
    );
    if (head && !head.startsWith(describes)) return undefined;
  }
  return operation;
}

export async function gatewayUpdate(params: GatewayUpdateParams): Promise<CheckoutUpdateOperation> {
  if (
    !params ||
    typeof params.localSha !== 'string' ||
    typeof params.targetSha !== 'string' ||
    !/^[a-f0-9]{7,40}$/.test(params.localSha) ||
    !/^[a-f0-9]{7,40}$/.test(params.targetSha)
  )
    throw new Error('Refresh the checkout status before updating.');
  const previous = await readCheckoutUpdate();
  if (previous?.phase === 'running') return previous;
  const path = await recordPath();
  try {
    await mkdir(`${path}.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Another checkout update is starting. Check again shortly.');
    throw error;
  }
  const operation: CheckoutUpdateOperation = {
    id: crypto.randomUUID(),
    phase: 'running',
    localSha: params.localSha,
    targetSha: params.targetSha,
    message: 'Starting checkout update…',
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeOperation(path, operation);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../../../scripts/update-checkout.mjs', import.meta.url)),
        farmslotRoot,
        path,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NODE_OPTIONS: '' },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return operation;
  } catch (error) {
    await writeOperation(path, {
      ...operation,
      phase: 'error',
      message: 'Could not start the update worker.',
    });
    await rm(`${path}.lock`, { recursive: true, force: true });
    throw error;
  }
}
