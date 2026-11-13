import assert from 'node:assert/strict';
import test from 'node:test';

import { applyArtifactOnlyTaskPolicy } from './artifact-only.js';

test('artifact replay instructions preserve replacement patterns and the heading', () => {
  const base = "synthetic-$'-$&-$`-$$-$1";
  const template = '# Synthetic task\n\nInspect `git diff main...HEAD`.\n';
  const rendered = applyArtifactOnlyTaskPolicy(template, { base });
  assert.ok(rendered.startsWith('# Synthetic task\n\n## Artifact-only replay guardrails\n'));
  assert.ok(rendered.includes(`This task is an artifact-only comparison replay from \`${base}\`.`));
  assert.ok(rendered.includes(`Inspect \`git diff ${base}\`.`));
});
