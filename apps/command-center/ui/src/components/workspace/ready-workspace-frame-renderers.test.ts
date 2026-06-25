import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReadyGatePayload } from '@farmslot/protocol';

import { readyWorkspaceShowsReportEvidencePreview } from './ready-workspace-frame-renderers.js';

test('readyWorkspaceShowsReportEvidencePreview hides the recipe-run strip for package gates', () => {
  assert.equal(
    readyWorkspaceShowsReportEvidencePreview({
      prPackage: { draftBody: 'body' } as ReadyGatePayload['prPackage'],
    }),
    false,
  );
});

test('readyWorkspaceShowsReportEvidencePreview keeps the recipe-run strip for legacy ready gates', () => {
  assert.equal(readyWorkspaceShowsReportEvidencePreview({}), true);
});