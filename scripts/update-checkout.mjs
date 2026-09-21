// Detached from the gateway so a dev watcher restart cannot interrupt Git.
import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function updateCheckout(root, recordPath) {
  const operation = JSON.parse(await readFile(recordPath, 'utf8'));
  const git = async (...args) =>
    (
      await exec('git', args, {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    ).stdout.trim();
  const save = async (change) => {
    Object.assign(operation, change, { updatedAt: new Date().toISOString() });
    await writeFile(`${recordPath}.tmp`, JSON.stringify(operation), { mode: 0o600 });
    await rename(`${recordPath}.tmp`, recordPath);
  };
  try {
    await save({
      phase: 'running',
      pid: process.pid,
      message: 'Checking the checkout and remote…',
    });
    const branch = (await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).replace(
      /^origin\//,
      '',
    );
    const checkLocal = async () => {
      if ((await git('symbolic-ref', '--quiet', '--short', 'HEAD')) !== branch)
        throw new Error(`Switch the checkout to ${branch} before updating.`);
      if (await git('status', '--porcelain', '--untracked-files=normal'))
        throw new Error(
          'The checkout has local changes. Commit or move them before updating. Nothing was changed.',
        );
      if (!(await git('rev-parse', 'HEAD')).startsWith(operation.localSha))
        throw new Error(
          'The local commit changed. Refresh and review the new update before retrying.',
        );
    };
    await checkLocal();
    // Do not overwrite FETCH_HEAD while the operator is fetching or pulling.
    await git('fetch', '--no-write-fetch-head', 'origin', branch);
    const target = await git('rev-parse', `origin/${branch}`);
    if (!target.startsWith(operation.targetSha))
      throw new Error('A newer remote commit is available. Refresh and review it before updating.');
    await git('merge-base', '--is-ancestor', 'HEAD', target);
    const files = (await git('diff', '--name-only', 'HEAD', target)).split('\n');
    let dependenciesChanged = files.some(
      (file) => /(^|\/)(yarn\.lock|\.yarnrc\.yml)$/.test(file) || file.startsWith('.yarn/'),
    );
    for (const file of files.filter((name) => /(^|\/)package\.json$/.test(name))) {
      const manifests = await Promise.all(
        ['HEAD', target].map(async (ref) => {
          try {
            return JSON.parse(await git('show', `${ref}:${file}`));
          } catch {
            return null;
          } // Added/deleted manifests require dependency installation.
        }),
      );
      const keys = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
        'resolutions',
        'workspaces',
        'packageManager',
      ];
      if (
        manifests.some((value) => !value) ||
        keys.some(
          (key) => JSON.stringify(manifests[0]?.[key]) !== JSON.stringify(manifests[1]?.[key]),
        )
      )
        dependenciesChanged = true;
    }
    if (dependenciesChanged)
      throw new Error(
        'This update changes dependencies. Update the checkout and run yarn install --immutable in a terminal. Nothing was changed.',
      );
    await save({
      message: 'Applying the fast-forward update…',
      desktopRebuildRequired: files.some((file) => file.startsWith('apps/command-center-desktop/')),
      gatewayRestartRequired: files.some((file) => /^(services\/gateway|packages)\//.test(file)),
    });
    await checkLocal();
    await git('merge', '--ff-only', '--no-overwrite-ignore', target);
    if ((await git('rev-parse', 'HEAD')) !== target)
      throw new Error('The checkout did not reach the expected commit. Check it in a terminal.');
    await save({
      phase: 'complete',
      message: `Checkout updated to ${target.slice(0, 8)}.`,
      targetSha: target,
    });
  } catch (error) {
    await save({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    await rm(`${recordPath}.lock`, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await updateCheckout(process.argv[2], process.argv[3]);
}
