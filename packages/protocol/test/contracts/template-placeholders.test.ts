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

test('the shared CI part numbers its executable row and keeps inserted values opaque', () => {
  const source =
    '## Checklist\n- [ ] **1. Work** {{ISSUES}}\n{{CI_PARITY_STEP}}\n- [ ] **2. Finish**';
  const rendered = renderTemplatePlaceholders(source, {
    TASK_DIR: '.task/proof',
    ISSUES: '{{REPO}}',
    REPO: 'must-not-reexpand',
    'ci.local_check': 'yarn ci:local',
    CI_PARITY_CHECKLIST: 'CHECKLIST.md',
  });
  assert.match(rendered, /\*\*2\. CI parity\*\*/);
  assert.match(rendered, /mark --checklist CHECKLIST\.md 2/);
  assert.match(rendered, /\*\*3\. Finish\*\*/);
  assert.match(rendered, /\{\{REPO\}\}/);
  assert.equal((rendered.match(/\[DETERMINISTIC:/g) ?? []).length, 1);
});

test('unconfigured projects retain their checklist and interactive CI uses its task target', () => {
  assert.equal(renderTemplatePlaceholders('before{{CI_PARITY_STEP}}after', {}), 'beforeafter');
  const rendered = renderTemplatePlaceholders('{{CI_PARITY_STEP}}', {
    TASK_DIR: '.task/proof',
    'ci.local_check': 'true',
    CI_PARITY_CHECKLIST: 'TASK.md',
  });
  assert.match(rendered, /mark --checklist TASK\.md 1/);
});

test('every bundled PR checklist materializes one executable parity row before its preflight', () => {
  const templates = [
    ...['dev', 'dev-interactive', 'fix-bug', 'pr-complete', 'self-review-fix', 'update-branch'].map(
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
    assert.equal((rendered.match(/\[DETERMINISTIC:/g) ?? []).length, 1, file);
    assert.match(rendered, /^- \[ \] \*\*\d+\. CI parity\*\*/m, file);
    const preflight = rendered.indexOf('check-task-artifact-contract.mjs');
    if (preflight >= 0) assert.ok(rendered.indexOf('[DETERMINISTIC:') < preflight, file);
    assert.doesNotMatch(rendered, /learnings[^\n]+ - \[ \]/, file);
  }
});
