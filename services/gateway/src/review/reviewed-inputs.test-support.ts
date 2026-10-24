import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { farmslotRoot } from '../fleet/state.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { createRun, updateRun } from '../runs/store.js';

const execFileAsync = promisify(execFile);

export async function git(repo: string, ...args: string[]) {
  await execFileAsync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Farmslot Test',
    '-c',
    'user.email=farmslot-test@example.invalid',
    ...args,
  ]);
}

/** A local slot whose checkout holds a worker task dir with description and evidence. */
export async function slotWithTask(t: import('node:test').TestContext) {
  const id = `reviewed-inputs-${process.pid}-${Date.now()}`;
  const repo = await mkdtemp(path.join(os.tmpdir(), `${id}-`));
  const poolFile = path.join(farmslotRoot, 'pool', `${id}.json`);
  const taskRelDir = `test/${id}`;
  const artifacts = path.join(repo, '.sandbox/farmslot-farm/worker-task', taskRelDir, 'artifacts');
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: 'TAT-4031-LIKE',
    runner: 'claude',
  });
  updateRun(run.id, {
    slotId: `${id}-slot`,
    taskFile: path.join(farmslotRoot, '.sandbox/farmslot-farm/tasks', taskRelDir, 'TASK.md'),
  });
  t.after(async () => {
    await deleteTestRunIfPresent(run.id);
    await rm(poolFile, { force: true });
    await rm(repo, { recursive: true, force: true });
  });
  await writeFile(path.join(repo, 'README.md'), 'fixture\n');
  await execFileAsync('git', ['init', '-q', repo]);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'base');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'pr-description.md'), '## Removed surfaces\n- Banner\n');
  await writeFile(
    path.join(artifacts, 'evidence-manifest.json'),
    JSON.stringify({
      before_after_pairs: [{ label: 'flag on', before: 'on-before.png', after: 'on-after.png' }],
    }),
  );
  await writeFile(path.join(artifacts, 'on-after.png'), 'png-v1');
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project: 'farmslot-farm',
      platform: 'cli',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      slots: [{ id: `${id}-slot`, enabled: true, repo, session: `${id}-slot` }],
    }),
  );
  return { run, repo, artifacts };
}
