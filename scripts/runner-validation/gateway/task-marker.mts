// Public installed CLI plus production checklist routing, without a farm allocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SlotVars } from '../../../services/gateway/src/core/config.js';
import {
  restoreWorkerChecklistTargetOnSlot,
  syncChecklistTargetOnSlot,
} from '../../../services/gateway/src/tasks/checklist-target.js';

const selectedCli = process.env.FARMSLOT_PROOF_CLI;
assert.ok(selectedCli, 'Set FARMSLOT_PROOF_CLI to the installed immutable CLI entry');
const cli = realpathSync(selectedCli);
const root = mkdtempSync(path.join(tmpdir(), 'task-marker-proof-'));
const checkout = path.join(root, 'checkout');
const taskDir = '.task/role proof';
const absolute = path.join(checkout, taskDir);
const env = {
  ...process.env,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
};
const call = (...args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
let passed = false;
try {
  mkdirSync(path.join(root, 'templates/dev'), { recursive: true });
  mkdirSync(checkout);
  mkdirSync(env.FARMSLOT_POOL_DIR);
  mkdirSync(path.join(root, 'projects'));
  execFileSync('git', ['init', '-q'], { cwd: checkout });
  writeFileSync(
    path.join(root, 'templates/dev/worker.md'),
    '---\ndescription: Check role routing\n---\n\n# Steps\n- [ ] Verify the selected checklist\n',
  );
  call(
    'task',
    'init',
    absolute,
    '--target',
    checkout,
    '--projects-dir',
    path.join(root, 'projects'),
    '--dir',
    path.join(root, 'templates'),
    '--flow',
    'dev',
    '--platform',
    'cli',
    '--template',
    'dev/worker',
    '--title',
    'Retain task tooling across role changes',
  );
  const marker = readFileSync(path.join(absolute, 'mark'));
  const receipt = readFileSync(path.join(absolute, 'artifacts/harness-provenance.json'));
  const vars: SlotVars = {
    slotId: 'marker-proof',
    machine: 'marker-proof',
    host: 'localhost',
    platform: 'cli',
    sshUser: '',
    osType: process.platform,
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: checkout,
    remoteRepo: checkout,
    session: 'marker-proof',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'unbound-static-proof',
    resourceVars: {},
  };
  for (const checklist of ['REVIEW.md', 'REVIEW-FIX.md', 'CI-FIX.md']) {
    writeFileSync(path.join(absolute, checklist), '# Steps\n- [ ] Verify role routing\n');
    await syncChecklistTargetOnSlot(vars, taskDir, checklist);
    assert.deepEqual(readFileSync(path.join(absolute, 'mark')), marker);
    execFileSync('bash', [path.join(absolute, 'mark'), '1'], {
      cwd: checkout,
      env: { ...env, FARMSLOT_MARK_CMD: 'false' },
      timeout: 30_000,
    });
    assert.match(readFileSync(path.join(absolute, checklist), 'utf8'), /\[x\]/);
    assert.match(readFileSync(path.join(absolute, 'CHECKLIST.md'), 'utf8'), /\[ \]/);
    assert.ok(existsSync(path.join(absolute, checklist.replace('.md', '-SIGNAL.json'))));
  }
  await restoreWorkerChecklistTargetOnSlot(vars, taskDir, true);
  assert.equal(existsSync(path.join(absolute, 'checklist-target.json')), false);
  execFileSync('bash', [path.join(absolute, 'mark'), '1'], {
    cwd: checkout,
    env: { ...env, FARMSLOT_MARK_CMD: 'false' },
    timeout: 30_000,
  });
  assert.match(readFileSync(path.join(absolute, 'CHECKLIST.md'), 'utf8'), /\[x\]/);
  assert.ok(existsSync(path.join(absolute, 'SIGNAL.json')));
  call('task', 'verify', absolute, '--json');
  assert.deepEqual(readFileSync(path.join(absolute, 'mark')), marker);
  assert.deepEqual(readFileSync(path.join(absolute, 'artifacts/harness-provenance.json')), receipt);
  passed = true;
} finally {
  rmSync(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      pass: passed,
      cli,
      scratch: root,
      removed: !existsSync(root),
      checks: [
        'public task init and verify',
        'three role targets and their signals',
        'worker restoration and signal',
        'fixed marker ignores environment override',
        'marker and provenance bytes preserved',
      ],
    }),
  );
}
