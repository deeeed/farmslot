// Byte-for-byte goldens of the farmslot-farm review document, captured
// before the description and evidence check existed. The rendered document must
// equal its golden followed by the shared scope packet and description check.
// Regenerate only on purpose: FARMSLOT_UPDATE_REVIEW_GOLDENS=1.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { farmslotRoot } from '../projects/repo-root.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { expandReviewTemplate } from './templates.js';

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'review-golden',
);
const UPDATE = process.env.FARMSLOT_UPDATE_REVIEW_GOLDENS === '1';
const SECTION_HEADING = '## Diff scope';

for (const depth of ['static-code', 'full-live'] as const) {
  test(`farmslot-farm ${depth} review preserves its golden before the shared scope and description checks`, async (t) => {
    const run = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'farmslot-farm',
      ticketOrPr: 'GOLDEN-REVIEW',
      runner: 'claude',
    });
    t.after(async () => {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    });
    const rendered = (
      await expandReviewTemplate(
        {
          slotId: 'golden-slot',
          projectName: 'farmslot-farm',
          host: 'localhost',
          machine: 'golden-machine',
          remoteRepo: '/nonexistent/golden-repo',
          platform: 'cli',
          session: 'golden-slot',
          resourceVars: { port: '8061' },
        } as never,
        'temp/tasks/golden/review',
        run.id,
        depth,
      )
    )
      .split(farmslotRoot)
      .join('<FARMSLOT_ROOT>');
    const goldenPath = path.join(GOLDEN_DIR, `${depth}.golden`);
    const at = rendered.indexOf(SECTION_HEADING);
    assert.ok(at > 0, 'the shared scope check is rendered');
    if (UPDATE) {
      // The golden is the document before the check, as captured on main.
      await mkdir(GOLDEN_DIR, { recursive: true });
      await writeFile(goldenPath, `${rendered.slice(0, at).trimEnd()}\n`, 'utf-8');
      return;
    }
    const golden = await readFile(goldenPath, 'utf-8');
    assert.equal(rendered.slice(0, at).trimEnd(), golden.trimEnd());
    assert.equal(
      rendered.lastIndexOf('## Description and evidence check') > at,
      true,
      'shared scope and inventory precede the existing final description check',
    );
  });
}
