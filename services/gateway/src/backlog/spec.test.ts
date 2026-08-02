import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBacklogAcceptanceCriteria, stripBacklogAcceptanceCriteriaSection } from './spec.js';

const SPEC = [
  '# Roadmap delivery projection',
  '',
  '## Problem',
  '',
  'Planning state and delivery evidence drift apart.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Checkbox-formatted AC keeps only the criterion text',
  '- [x] Checked checkbox AC is treated the same',
  '- Plain bullet AC stays as-is',
  '',
  '## Dispatch Notes',
  '',
  'Use the existing backlog queue.',
].join('\n');

test('extractBacklogAcceptanceCriteria strips checkbox markers from AC lines', () => {
  assert.deepEqual(extractBacklogAcceptanceCriteria(SPEC), [
    'Checkbox-formatted AC keeps only the criterion text',
    'Checked checkbox AC is treated the same',
    'Plain bullet AC stays as-is',
  ]);
});

test('stripBacklogAcceptanceCriteriaSection removes only the AC section', () => {
  const stripped = stripBacklogAcceptanceCriteriaSection(SPEC);
  assert.doesNotMatch(stripped, /## Acceptance Criteria/);
  assert.doesNotMatch(stripped, /Checkbox-formatted AC/);
  assert.match(stripped, /## Problem/);
  assert.match(stripped, /## Dispatch Notes/);
  assert.match(stripped, /Use the existing backlog queue\./);
});

test('stripBacklogAcceptanceCriteriaSection is a no-op without an AC section', () => {
  const markdown = '# Spec\n\n## Problem\n\nNo ACs here.';
  assert.equal(stripBacklogAcceptanceCriteriaSection(markdown), markdown);
});
