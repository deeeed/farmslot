import assert from 'node:assert/strict';
import test from 'node:test';

import { applyArtifactOnlyTaskPolicy } from './artifact-only.js';

// Eval run 9317844e shipped TASK.md lines naming `selected reference/base`,
// the gateway's placeholder for an unknown base, and the worker went looking
// for that ref in git history. With no base to name, the guardrails must drop
// the comparison lines instead of naming something that cannot be resolved.
test('artifact replay guardrails omit the comparison lines when no base is known', () => {
  const template = '# Synthetic task\n\nInspect `git diff main...HEAD`.\n';
  const rendered = applyArtifactOnlyTaskPolicy(template, { base: undefined });
  assert.ok(rendered.includes('## Artifact-only replay guardrails'));
  assert.equal(rendered.includes('comparison replay from'), false);
  assert.ok(rendered.includes('No replay base was recorded'));
  // A bare `git diff` is the working-tree instruction and is fine; what must
  // never appear is a command whose ref argument is missing or a placeholder.
  assert.equal(/git (?:diff|log)\s+(?:`|$|\.\.)/m.test(rendered), false, rendered.slice(0, 400));
  assert.equal(rendered.includes('undefined'), false, rendered.slice(0, 400));
  assert.equal(rendered.includes('selected reference/base'), false, rendered.slice(0, 400));
});

test('artifact replay instructions preserve replacement patterns and the heading', () => {
  const base = "synthetic-$'-$&-$`-$$-$1";
  const template = '# Synthetic task\n\nInspect `git diff main...HEAD`.\n';
  const rendered = applyArtifactOnlyTaskPolicy(template, { base });
  assert.ok(rendered.startsWith('# Synthetic task\n\n## Artifact-only replay guardrails\n'));
  assert.ok(rendered.includes(`This task is an artifact-only comparison replay from \`${base}\`.`));
  assert.ok(rendered.includes(`Inspect \`git diff ${base}\`.`));
});
