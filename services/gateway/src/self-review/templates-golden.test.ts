// Byte-for-byte goldens of the farmslot-farm self-review document, captured
// before the description and evidence check existed. The rendered document must
// equal its golden followed by that one gateway-owned section and nothing else.
// Regenerate only on purpose: FARMSLOT_UPDATE_SELF_REVIEW_GOLDENS=1.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { farmslotRoot } from '../projects/repo-root.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { expandSelfReviewTemplate } from './templates.js';

const GOLDEN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'self-review-golden',
);
const UPDATE = process.env.FARMSLOT_UPDATE_SELF_REVIEW_GOLDENS === '1';
const SECTION_HEADING = '## Description and evidence check';

for (const depth of ['static-code', 'full-live'] as const) {
  test(`farmslot-farm ${depth} self-review is its golden plus only the description check`, async (t) => {
    const run = createRun({
      flowType: 'dev',
      mode: 'autonomous',
      project: 'farmslot-farm',
      ticketOrPr: 'GOLDEN-SELF-REVIEW',
      runner: 'claude',
    });
    t.after(async () => {
      updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    });
    const rendered = (
      await expandSelfReviewTemplate(
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
        'temp/tasks/golden/self-review',
        run.id,
        depth,
      )
    )
      .split(farmslotRoot)
      .join('<FARMSLOT_ROOT>');
    const goldenPath = path.join(GOLDEN_DIR, `${depth}.golden`);
    const at = rendered.indexOf(SECTION_HEADING);
    assert.ok(at > 0, 'the description and evidence check is rendered');
    if (UPDATE) {
      // The golden is the document before the check, as captured on main.
      await mkdir(GOLDEN_DIR, { recursive: true });
      await writeFile(goldenPath, `${rendered.slice(0, at).trimEnd()}\n`, 'utf-8');
      return;
    }
    const golden = await readFile(goldenPath, 'utf-8');
    assert.equal(rendered.slice(0, at).trimEnd(), golden.trimEnd());
    assert.equal(
      rendered.indexOf('\n## ', at + SECTION_HEADING.length),
      -1,
      'the check is the last section',
    );
  });
}
