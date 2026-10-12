import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { farmslotRoot } from '../../core/config.js';

import { resolveCandidateTemplateProvenance } from './candidate-setup.js';

test('catalog eval keeps a selected local variant and its exact template snapshot', async (t) => {
  const name = `eval-catalog-${process.pid}-farm`;
  const root = path.join(farmslotRoot, 'projects', name);
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'project.json'),
    JSON.stringify({ name, execution_templates: { sources: [] } }),
  );
  const content =
    '---\nid: dev/treatment\nflow: dev\n---\n\n# Treatment\n\n- [ ] Validate the candidate.\n';
  await writeFile(path.join(root, 'templates/worker/dev-treatment.md'), content);
  const result = await resolveCandidateTemplateProvenance(name, 'dev', {
    template: { path: 'templates/worker/dev-treatment.md' },
    model: { name: 'comparison-model' },
  });
  assert.equal(result.executionTemplate?.id, 'dev/treatment');
  assert.equal(result.executionTemplate?.sha256, result.provenance?.contentHash);
  assert.equal(result.templateContent, content);
  assert.equal(result.taskTemplate, undefined);
  assert.equal(result.mode, 'interactive');
  assert.equal(result.axes.model?.name, 'comparison-model');
  assert.equal(result.axes.template?.path, 'templates/worker/dev-treatment.md');
});
