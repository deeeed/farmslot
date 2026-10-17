import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// slot-config reads FARMSLOT_PROJECTS_DIR once, at import.
const projects = mkdtempSync(path.join(tmpdir(), 'task-root-override-'));
const linkedTarget = `${projects}-linked`;
after(() => {
  rmSync(projects, { recursive: true, force: true });
  rmSync(linkedTarget, { recursive: true, force: true });
});
process.env.FARMSLOT_PROJECTS_DIR = projects;
const { farmslotRoot, getOrchestratorTaskRoot, projectTaskRoots } = await import('./config.js');

test('task roots follow FARMSLOT_PROJECTS_DIR, and mock mode keeps the root sandbox', () => {
  assert.equal(getOrchestratorTaskRoot('demo'), path.join(projects, 'demo', 'tasks'));
  assert.equal(
    getOrchestratorTaskRoot('demo', { external: { mock_mode: true } }),
    path.join(farmslotRoot, '.sandbox', 'demo', 'tasks'),
  );
});

test('projectTaskRoots lists project dirs, linked ones included', async () => {
  mkdirSync(path.join(projects, 'app'));
  mkdirSync(linkedTarget);
  symlinkSync(linkedTarget, path.join(projects, 'linked'));
  const roots = await projectTaskRoots();
  assert.deepEqual(
    roots.sort((a, b) => a.project.localeCompare(b.project)),
    [
      { project: 'app', root: path.join(projects, 'app', 'tasks') },
      { project: 'linked', root: path.join(projects, 'linked', 'tasks') },
    ],
  );
});
