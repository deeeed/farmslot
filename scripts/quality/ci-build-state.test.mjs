import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildProjects, verifyBuildReceipt, writeBuildReceipt } from './ci-build-state.mjs';

test('prebuilt ownership requires matching source/config/lock and existing outputs', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-build-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'packages/a/src'), { recursive: true });
  mkdirSync(path.join(root, 'packages/a/dist'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(
    path.join(root, 'packages/a/package.json'),
    JSON.stringify({
      name: '@farmslot/a',
      scripts: { build: 'rm -rf dist && tsc --project tsconfig.json' },
    }),
  );
  writeFileSync(path.join(root, 'packages/a/tsconfig.json'), '{}');
  writeFileSync(path.join(root, 'packages/a/src/index.ts'), 'export const value = 1;');
  const projects = buildProjects(root);
  assert.equal(projects.length, 1);
  writeBuildReceipt(root, projects);
  assert.doesNotThrow(() => verifyBuildReceipt(root));
  writeFileSync(path.join(root, 'packages/a/src/index.ts'), 'export const value = 2;');
  assert.throws(() => verifyBuildReceipt(root), /does not match/);
  writeBuildReceipt(root, projects);
  rmSync(path.join(root, 'packages/a/dist'), { recursive: true });
  assert.throws(() => verifyBuildReceipt(root));
});
