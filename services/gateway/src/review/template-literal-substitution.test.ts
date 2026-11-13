import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { enumerateChecklistCheckboxes } from '@farmslot/protocol/checklist-target';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { farmslotRoot } from '../fleet/state.js';
import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

import { expandReviewFixTemplate } from './templates.js';

test('REVIEW-FIX preserves replacement patterns verbatim without adding checklist steps', async (t) => {
  const project = `.literal-review-fix-${process.pid}`;
  const root = path.join(farmslotRoot(), 'projects', project);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    invalidateProjectVarsCache(project);
  });
  await mkdir(path.join(root, 'templates/worker'), { recursive: true });
  await writeFile(path.join(root, 'project.json'), JSON.stringify({ name: project }));
  const template = [
    '# Review fix',
    '- [ ] **1. Read findings**',
    '{{ISSUES}}',
    '- [ ] **2. Validate fixes**',
    '- [ ] **3. Complete**',
    '{{REVIEW_FEEDBACK_FILES}}',
  ].join('\n');
  await writeFile(path.join(root, 'templates/worker/review-fix.md'), template);
  invalidateProjectVarsCache(project);

  const description = "Synthetic finding: $' | $& | $` | $$ | $1 | $<name> must stay literal.";
  const vars = makeVars({ projectName: project });
  const rendered = await expandReviewFixTemplate(vars, 'tasks/fix', makeRun({ project }), [
    { file: 'synthetic.ts', line: 7, description },
  ]);
  assert.equal(
    enumerateChecklistCheckboxes(rendered).length,
    enumerateChecklistCheckboxes(template).length,
    'finding text must not duplicate template checklist steps',
  );
  assert.equal(rendered.split(description).length - 1, 1, 'finding must appear verbatim once');
  assert.ok(rendered.includes(`- **synthetic.ts:7** — ${description}`));
});
