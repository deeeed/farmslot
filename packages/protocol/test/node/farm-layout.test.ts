import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listProjectTaskRoots,
  ORCHESTRATOR_TASK_DIR,
  orchestratorTaskRoot,
  resolveProjectsDir,
} from '../../src/node/farm-layout.js';

const root = path.resolve('/farm');

test('the projects dir is the override when set, else <root>/projects', () => {
  assert.equal(resolveProjectsDir(root, {}), path.join(root, 'projects'));
  assert.equal(
    resolveProjectsDir(root, { FARMSLOT_PROJECTS_DIR: 'relative/projects' }),
    path.resolve('relative/projects'),
  );
});

test('a task root sits in the projects dir, and mock mode keeps the root sandbox', () => {
  const layout = { farmslotRoot: root, projectsDir: path.resolve('/elsewhere/projects') };
  assert.equal(
    orchestratorTaskRoot(layout, 'demo'),
    path.join('/elsewhere/projects', 'demo', ORCHESTRATOR_TASK_DIR),
  );
  assert.equal(
    orchestratorTaskRoot(layout, 'demo', true),
    path.join(root, '.sandbox', 'demo', ORCHESTRATOR_TASK_DIR),
  );
});

test('project task roots cover real and linked project dirs, never files or dangling links', async (t) => {
  const farm = mkdtempSync(path.join(tmpdir(), 'farm-layout-'));
  t.after(() => rmSync(farm, { recursive: true, force: true }));
  const projectsDir = path.join(farm, 'projects');
  mkdirSync(path.join(projectsDir, 'app'), { recursive: true });
  mkdirSync(path.join(farm, 'linked-target'));
  symlinkSync(path.join(farm, 'linked-target'), path.join(projectsDir, 'linked'));
  symlinkSync(path.join(farm, 'missing'), path.join(projectsDir, 'dangling'));
  writeFileSync(path.join(projectsDir, 'README.md'), '# projects');
  const layout = { farmslotRoot: farm, projectsDir };

  const roots = await listProjectTaskRoots(layout);

  assert.deepEqual(
    roots.sort((a, b) => a.project.localeCompare(b.project)),
    [
      { project: 'app', root: path.join(projectsDir, 'app', ORCHESTRATOR_TASK_DIR) },
      { project: 'linked', root: path.join(projectsDir, 'linked', ORCHESTRATOR_TASK_DIR) },
    ],
  );
  assert.deepEqual(
    await listProjectTaskRoots({ farmslotRoot: farm, projectsDir: path.join(farm, 'none') }),
    [],
  );
});
