import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import { resolveCiFixTemplatePath } from './inline-fix.js';

test('resolveCiFixTemplatePath prefers project-owned ci-fix.md', async () => {
  const project = `ci-fix-test-${Date.now()}`;
  const projectDir = path.join(farmslotRoot, 'projects', project, 'templates', 'worker');
  await mkdir(projectDir, { recursive: true });
  const projectTemplate = path.join(projectDir, 'ci-fix.md');
  await writeFile(projectTemplate, '# test\n', 'utf-8');
  try {
    const resolved = await resolveCiFixTemplatePath(project);
    assert.equal(resolved, projectTemplate);
  } finally {
    await rm(path.join(farmslotRoot, 'projects', project), { recursive: true, force: true });
  }
});

test('resolveCiFixTemplatePath falls back to Farmslot default template', async () => {
  const resolved = await resolveCiFixTemplatePath('__missing-project-for-ci-fix-test__');
  assert.equal(resolved, path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'));
});
