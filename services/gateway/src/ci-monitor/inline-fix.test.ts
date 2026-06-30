import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../core/config.js';

import { resolveCiFixTemplatePath } from './inline-fix.js';

test('resolveCiFixTemplatePath prefers project-owned ci-fix.md', async () => {
  const resolved = await resolveCiFixTemplatePath('metamask-core-farm');
  assert.equal(
    resolved,
    path.join(farmslotRoot, 'projects', 'metamask-core-farm', 'templates', 'worker', 'ci-fix.md'),
  );
});

test('resolveCiFixTemplatePath falls back to Farmslot default template', async () => {
  const resolved = await resolveCiFixTemplatePath('__missing-project-for-ci-fix-test__');
  assert.equal(resolved, path.join(farmslotRoot, 'templates', 'worker', 'ci-fix.md'));
});
