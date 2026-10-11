import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTimedSteps } from './lib/step-timing.mjs';
import { ciParitySteps } from './ci-local.mjs';

test('local parity scopes formatting without dropping global checks and stops at a failure', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'changed.ts'), 'export {};\n');
  const steps = ciParitySteps(['changed.ts', 'deleted.ts'], root);
  assert.ok(steps[0][1].includes(path.join(root, 'changed.ts')));
  assert.ok(!steps[0][1].includes(path.join(root, 'deleted.ts')));
  assert.ok(steps.some(([, command]) => command.includes('quality:authorization')));
  assert.ok(steps.some(([, command]) => command.includes('test:project-hooks')));
  let calls = 0;
  const result = runTimedSteps(steps, {
    prefix: 'proof',
    log: () => {},
    spawn: () => ({ status: ++calls === 2 ? 7 : 0 }),
  });
  assert.equal(calls, 2);
  assert.equal(result.failure.status, 7);
});

test('CI uses the shared parity command and has no second list of those guards', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/farmslot-quality.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /run: yarn ci:local/);
  for (const name of [
    'format:check',
    'quality:authorization',
    'quality:method-matrix',
    'test:project-hooks',
  ]) {
    assert.ok(!workflow.includes(`run: yarn ${name}`), `${name} duplicated in workflow`);
  }
});
