import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { getRunnerDefinition } from './registry.js';

const exec = promisify(execFile);

test('review trust preserves configuration across concurrent workspaces and refuses corrupt JSON', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-trust-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.claude.json');
  await writeFile(
    file,
    JSON.stringify({ theme: 'dark', projects: { '/existing': { allowedTools: ['read'] } } }),
  );
  const seed = (checkout: string) =>
    exec(
      process.execPath,
      ['-e', getRunnerDefinition('claude').reviewWorkspaceTrustSeed!(checkout)],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: directory } },
    );
  await Promise.all(['/review-a', '/review-b'].map(seed));
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.projects['/existing'], { allowedTools: ['read'] });
  assert.equal(config.projects['/review-a'].hasTrustDialogAccepted, true);
  assert.equal(config.projects['/review-b'].hasTrustDialogAccepted, true);
  const holder = spawn('python3', [
    '-c',
    "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\ntime.sleep(60)",
    file + '.farmslot-review.lock',
  ]);
  t.after(() => {
    holder.kill('SIGKILL');
  });
  const exited = once(holder, 'exit');
  await once(holder.stdout, 'data');
  holder.kill('SIGKILL');
  await exited;
  await seed('/after-crash');
  assert.equal(
    JSON.parse(await readFile(file, 'utf8')).projects['/after-crash'].hasTrustDialogAccepted,
    true,
  );
  await writeFile(file, '{broken');
  await assert.rejects(seed('/review-c'));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
