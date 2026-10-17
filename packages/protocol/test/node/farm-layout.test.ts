import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
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
