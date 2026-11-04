// Executed by the frozen ci.local_check, never directly by the worker.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const base =
  process.env.FARMSLOT_CI_BASE_REF || git(['merge-base', 'origin/main', 'HEAD']).trim();
const files = [
  ...new Set([
    ...git(['diff', '--name-only', '--no-renames', '-z', base]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ]),
].filter(
  (file) => !file.startsWith('.agent/') && /\.[cm]?[jt]sx?$/.test(file) && existsSync(file),
);

if (files.length) {
  const result = spawnSync(
    'corepack',
    ['yarn', 'lint', ...files.flatMap((file) => ['--file', file])],
    { stdio: 'inherit', env: { ...process.env, CI: 'true' } },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  console.log('No changed lintable files; full builds and global checks remain in CI.');
}
