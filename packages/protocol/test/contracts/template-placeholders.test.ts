import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNoUnknownPlaceholders,
  collectPlaceholderTokens,
  renderTemplatePlaceholders,
} from '../../src/index.js';

test('renderTemplatePlaceholders expands supplied vars', () => {
  assert.equal(
    renderTemplatePlaceholders('cd {{REPO}} && cat {{TASK_DIR}}/TASK.md', {
      REPO: '/tmp/r',
      TASK_DIR: '.task/t1',
    }),
    'cd /tmp/r && cat .task/t1/TASK.md',
  );
});

test('renderTemplatePlaceholders fails hard on placeholders outside the var set', () => {
  assert.throws(
    () =>
      renderTemplatePlaceholders(
        'read {{ORIGINAL_TICKET}}',
        { TICKET: 'X-1' },
        'Worker template pr-complete.md',
      ),
    /Worker template pr-complete\.md.*\{\{ORIGINAL_TICKET\}\}/,
  );
});

test('malformed tokens are collected and rejected even when the name is "known"', () => {
  assert.deepEqual(
    [...collectPlaceholderTokens('a {{foo-bar}} b {{OK}}')],
    ['{{foo-bar}}', '{{OK}}'],
  );
  assert.throws(
    () => assertNoUnknownPlaceholders('{{foo-bar}}', ['foo-bar'], 'x'),
    /\{\{foo-bar\}\}/,
  );
  assert.doesNotThrow(() => assertNoUnknownPlaceholders('{{OK}}', new Set(['OK']), 'x'));
});

test('legacy CI parts disappear while inserted values stay opaque', () => {
  const source =
    '## Checklist\n- [ ] **1. Work** {{ISSUES}}\n{{CI_PARITY_STEP}}\n- [ ] **3. Finish**';
  const rendered = renderTemplatePlaceholders(source, {
    TASK_DIR: '.task/proof',
    ISSUES: '{{REPO}}',
    REPO: 'must-not-reexpand',
    'ci.local_check': 'yarn ci:local',
    CI_PARITY_CHECKLIST: 'CHECKLIST.md',
  });
  assert.doesNotMatch(rendered, /CI parity|CI_PARITY_STEP/);
  assert.match(rendered, /\*\*2\. Finish\*\*/);
  assert.match(rendered, /\{\{REPO\}\}/);
  assert.equal((rendered.match(/\[DETERMINISTIC:/g) ?? []).length, 0);
});

test('configured and unconfigured legacy CI parts render empty', () => {
  assert.equal(renderTemplatePlaceholders('before{{CI_PARITY_STEP}}after', {}), 'beforeafter');
  const rendered = renderTemplatePlaceholders('{{CI_PARITY_STEP}}', {
    TASK_DIR: '.task/proof',
    'ci.local_check': 'true',
    CI_PARITY_CHECKLIST: 'TASK.md',
  });
  assert.equal(rendered, '');
});

test('bundled PR checklists omit the local parity step', () => {
  const templates = [
    ...['dev', 'dev-interactive', 'fix-bug', 'pr-complete', 'review-fix', 'update-branch'].map(
      (name) => `projects/farmslot-farm/templates/worker/${name}.md`,
    ),
    'templates/worker/ci-fix.md',
  ];
  for (const file of templates) {
    const source = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
    const vars = Object.fromEntries(
      [...collectPlaceholderTokens(source)].map((token) => [token.slice(2, -2), 'fixture']),
    );
    vars['ci.local_check'] = 'true';
    const rendered = renderTemplatePlaceholders(source, vars);
    assert.doesNotMatch(rendered, /CI_PARITY_STEP|DETERMINISTIC: ci\.local_check/, file);
    assert.doesNotMatch(rendered, /learnings[^\n]+ - \[ \]/, file);
  }
});
