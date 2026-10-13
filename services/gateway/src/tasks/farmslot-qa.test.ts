import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { projectWorkerTemplateSource, selectExecutionTemplate } from '@farmslot/agent-runtime';
import {
  enumerateChecklistCheckboxes,
  renderTemplatePlaceholders,
  resolveReviewQaDispatch,
} from '@farmslot/protocol';
import { validatePackPortability } from '@farmslot/protocol/node/pack-portability';
import { getProjectField } from '@farmslot/slot-config';

import type { ProjectVars } from '../core/config.js';

const pack = fileURLToPath(new URL('../../../../projects/farmslot-farm/', import.meta.url));
const project = JSON.parse(
  readFileSync(path.join(pack, 'project.json'), 'utf8'),
) as ProjectVars['projectJson'];
const sources = [projectWorkerTemplateSource(project.name!, path.join(pack, 'templates'))];

test('Farmslot QA intake selects the local validation checklist on every supported platform', () => {
  const inputs = { scope: { kind: 'ref', ref: 'abc123' }, criteria: ['Persist a gateway result'] };
  const selected = resolveReviewQaDispatch({ flowType: 'qa', qaInputs: inputs }, project.qa);
  assert.ok(selected?.flowType === 'qa');
  assert.equal(selected.qa.profile.id, 'pr');
  assert.deepEqual(selected.qa.inputs.scope, inputs.scope);
  for (const platform of ['cli', 'web', 'ios', 'android']) {
    const template = selectExecutionTemplate({
      sources,
      flow: 'qa',
      platform,
      runMode: 'validation',
      explicitId: selected.qa.profile.template_id,
    });
    assert.equal(template.entry.id, 'qa/default');
    assert.equal(template.entry.flow, 'qa');
    assert.equal(template.entry.relativePath, 'qa.md');
  }
  assert.deepEqual(validatePackPortability(pack), []);
});

test('Farmslot QA checklist renders CI parity before evidence and terminal completion', () => {
  const markdown = readFileSync(path.join(pack, 'templates/worker/qa.md'), 'utf8');
  const vars: Record<string, string> = {
    TASK_DIR: '.task/qa',
    REPO: '/fixture/repo',
    repo: '/fixture/repo',
    runtime_dir: '.agent',
    farmslot_dir: '/fixture/farmslot',
    'ci.local_check': getProjectField(project, 'ci.local_check'),
    CI_PARITY_CHECKLIST: 'CHECKLIST.md',
  };
  for (const [key, value] of Object.entries(project.vars ?? {}))
    vars[key] = renderTemplatePlaceholders(String(value), vars);
  const rendered = renderTemplatePlaceholders(markdown, vars);
  const steps = enumerateChecklistCheckboxes(rendered);
  assert.equal(steps.length, 7);
  assert.match(steps[4].rawLabel, /DETERMINISTIC: ci.local_check/);
  assert.match(steps[5].rawLabel, /qa-result.json/);
  assert.match(steps[6].rawLabel, /mark complete --mark-last/);
});

test('enabling Farmslot QA preserves the existing local flow selections and defaults', () => {
  for (const flow of ['fix-bug', 'review-pr', 'pr-complete', 'review', 'review-fix']) {
    const selected = selectExecutionTemplate({
      sources,
      flow,
      platform: 'cli',
      runMode: 'autonomous',
      defaults: project.execution_templates!.defaults,
    });
    assert.equal(selected.entry.relativePath, `${flow}.md`);
  }
  for (const [runMode, file] of [
    ['autonomous', 'dev.md'],
    ['interactive', 'dev-interactive.md'],
  ] as const) {
    const selected = selectExecutionTemplate({
      sources,
      flow: 'dev',
      platform: 'cli',
      runMode,
      defaults: project.execution_templates!.defaults,
    });
    assert.equal(selected.entry.relativePath, file);
  }
  assert.deepEqual(project.defaults!.fix, { runner: 'claude', model: 'opus' });
});
