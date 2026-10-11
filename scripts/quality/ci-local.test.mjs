import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runTimedSteps } from './lib/step-timing.mjs';
import { ciParitySteps } from './ci-local.mjs';

test('local parity scopes formatting without dropping global checks and stops at a failure', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changed = 'apps/command-center/ui/changed.ts';
  const deleted = 'apps/command-center/ui/deleted.ts';
  mkdirSync(path.dirname(path.join(root, changed)), { recursive: true });
  writeFileSync(path.join(root, changed), 'export {};\n');
  const steps = ciParitySteps([changed, deleted], root);
  assert.ok(steps[0][1].includes(path.join(root, changed)));
  assert.ok(!steps[0][1].includes(path.join(root, deleted)));
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

test('local format excludes farm templates and frozen evidence, just like the CI guard', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-format-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = [
    'projects/farm/templates/worker/dev.md',
    'docs/operations/evidence/receipt.json',
  ];
  const changed = 'apps/command-center/ui/changed.ts';
  for (const file of [...outside, changed]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), 'fixture');
  }
  const scoped = ciParitySteps([...outside, changed], root)[0][1];
  assert.ok(scoped.includes(path.join(root, changed)));
  for (const file of outside) assert.ok(!scoped.includes(path.join(root, file)));
  assert.deepEqual(ciParitySteps(outside, root)[0][1], ['yarn', 'format:check']);
});
