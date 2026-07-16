import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCIWatchChainedRunParams } from './ci-watch-chain.js';
import { makeRun } from './test-fixtures.js';

test('buildCIWatchChainedRunParams preserves lineage and converts pr-complete tickets to PR refs', () => {
  const current = makeRun({
    id: 'root-run',
    familyId: 'family-1',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-99',
    lane: 'comparison',
    variant: 'claude',
    ticketOrPr: 'PROJ-99',
    prNumber: 415,
    summary: 'Fix original scope',
  });

  const chain = buildCIWatchChainedRunParams(
    current,
    'dispatch-pr-complete',
    'example-org/example-mobile',
  );
  assert(chain);
  assert.equal(chain.flowType, 'pr-complete');
  assert.equal(chain.createParams.ticketOrPr, 'example-org/example-mobile#415');
  assert.equal(chain.createParams.familyId, current.familyId);
  assert.equal(chain.createParams.parentRunId, current.id);
  assert.equal(chain.createParams.familyRootTicketOrPr, current.familyRootTicketOrPr);
  assert.equal(chain.createParams.lane, current.lane);
  assert.equal(chain.createParams.variant, current.variant);
  assert.equal(chain.createParams.slotId, current.slotId);
  assert.equal(chain.createParams.model, current.metrics.model);
  assert.deepEqual(chain.updateFields, { prNumber: 415, summary: 'Fix original scope' });
  assert.deepEqual(chain.engineFlags, { skipPrepare: true });
});

test('buildCIWatchChainedRunParams skips prepare only when a warm source slot is pinned', () => {
  const withSlot = buildCIWatchChainedRunParams(
    makeRun({ slotId: 'runner-browser-1' }),
    'dispatch-pr-complete',
    'owner/repo',
  );
  assert(withSlot);
  assert.deepEqual(withSlot.engineFlags, { skipPrepare: true });

  const withoutSlot = buildCIWatchChainedRunParams(
    makeRun({ slotId: null }),
    'dispatch-pr-complete',
    'owner/repo',
  );
  assert(withoutSlot);
  assert.deepEqual(withoutSlot.engineFlags, {});
});

test('buildCIWatchChainedRunParams inherits parent runner+model unchanged for update-branch (no auto-upgrade to opus)', () => {
  // The historic "force opus on update-branch" upgrade caused the codex+opus
  // wedge — codex CLI accepted --model opus but the API rejected it with
  // HTTP 400. Removing the heuristic: chained update-branch now inherits the
  // parent's model, which is by construction compatible with the parent's
  // (and child's) runner. Flow-specific model preferences belong in project
  // config, not in chained-run logic.
  const current = makeRun({
    id: 'followup-run',
    familyId: 'family-2',
    lane: 'production',
    variant: null,
    ticketOrPr: 'owner/repo#500',
    prNumber: 500,
    metrics: {
      nudgeCount: 0,
      model: 'gpt-5.5-mini',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });

  const chain = buildCIWatchChainedRunParams(current, 'dispatch-update-branch', 'owner/repo');
  assert(chain);
  assert.equal(chain.flowType, 'update-branch');
  assert.equal(chain.createParams.ticketOrPr, 'owner/repo#500');
  assert.equal(chain.createParams.model, 'gpt-5.5-mini');
  assert.equal(chain.createParams.runner, 'codex');
  assert.equal(chain.createParams.lane, 'production');
  assert.equal(chain.createParams.variant, undefined);
});

test('buildCIWatchChainedRunParams inherits claude parent into update-branch without forcing opus', () => {
  const current = makeRun({
    id: 'followup-run-claude',
    familyId: 'family-3',
    lane: 'production',
    variant: null,
    ticketOrPr: 'owner/repo#600',
    metrics: {
      nudgeCount: 0,
      model: 'sonnet',
      runner: 'claude',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-update-branch', 'owner/repo');
  assert(chain);
  assert.equal(chain.createParams.model, 'sonnet');
  assert.equal(chain.createParams.runner, 'claude');
});

test('buildCIWatchChainedRunParams converts a manual-rooted update-branch chain to a PR ref', () => {
  // Regression: update-branch is PR-bound, so a chain inheriting a manual/Jira
  // ticket ref would throw `Invalid PR reference` at runCreate.
  // The CI-conflict path has an authoritative prNumber — convert to owner/repo#N.
  const current = makeRun({
    familyRootTicketOrPr: 'MANUAL-000014',
    ticketOrPr: 'MANUAL-000014',
    prNumber: 321,
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-update-branch', 'owner/repo');
  assert(chain);
  assert.equal(chain.flowType, 'update-branch');
  assert.equal(chain.createParams.ticketOrPr, 'owner/repo#321');
});

test('buildCIWatchChainedRunParams inherits parent safetyTier so chained flows keep posture', () => {
  const current = makeRun({ safetyTier: 'dangerous', prNumber: 700 });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-pr-complete', 'owner/repo');
  assert(chain);
  assert.equal(chain.createParams.safetyTier, 'dangerous');
});

test('buildCIWatchChainedRunParams leaves safetyTier undefined when parent has none', () => {
  const current = makeRun({ safetyTier: undefined });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-update-branch', 'owner/repo');
  assert(chain);
  assert.equal(chain.createParams.safetyTier, undefined);
});

test('buildCIWatchChainedRunParams forwards allowedSlots so the filter follows the chain', () => {
  const current = makeRun({
    allowedSlots: ['runner-browser-1', 'runner-browser-2'],
    prNumber: 500,
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-pr-complete', 'owner/repo');
  assert(chain);
  assert.deepEqual(chain.createParams.allowedSlots, ['runner-browser-1', 'runner-browser-2']);

  // Empty or missing allowedSlots drops back to undefined (unrestricted) so
  // legacy parents aren't pinned to an empty set.
  const unrestricted = buildCIWatchChainedRunParams(
    makeRun({ allowedSlots: null, prNumber: 500 }),
    'dispatch-pr-complete',
    'owner/repo',
  );
  assert(unrestricted);
  assert.equal(unrestricted.createParams.allowedSlots, undefined);

  const emptyAllowed = buildCIWatchChainedRunParams(
    makeRun({ allowedSlots: [], prNumber: 500 }),
    'dispatch-pr-complete',
    'owner/repo',
  );
  assert(emptyAllowed);
  assert.equal(emptyAllowed.createParams.allowedSlots, undefined);
});

test('buildCIWatchChainedRunParams uses flow baseline mode for chained pr-complete even when parent is interactive', () => {
  const current = makeRun({
    id: 'interactive-dev-parent',
    flowType: 'dev',
    mode: 'interactive',
    prNumber: 44002,
    ticketOrPr: 'TAT-3461',
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-pr-complete', 'owner/repo');
  assert(chain);
  assert.equal(chain.createParams.mode, 'autonomous');
});

test('buildCIWatchChainedRunParams uses flow baseline mode for chained update-branch', () => {
  const current = makeRun({
    id: 'autonomous-parent',
    flowType: 'pr-complete',
    mode: 'autonomous',
    prNumber: 500,
    ticketOrPr: 'owner/repo#500',
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-update-branch', 'owner/repo');
  assert(chain);
  assert.equal(chain.createParams.mode, 'interactive');
});

test('buildCIWatchChainedRunParams treats prNumber 0 as the invalid sentinel and falls back to ticketOrPr', () => {
  const current = makeRun({
    id: 'sentinel-zero',
    familyId: 'family-zero',
    ticketOrPr: 'PROJ-77',
    prNumber: 0,
    summary: 'Original ticket scope',
  });
  const chain = buildCIWatchChainedRunParams(current, 'dispatch-pr-complete', 'owner/repo');
  assert(chain);
  // Must not dispatch against owner/repo#0 — fall back to the original ticket.
  assert.equal(chain.createParams.ticketOrPr, 'PROJ-77');
  // updateFields must not propagate the sentinel either.
  assert.equal('prNumber' in chain.updateFields, false);
});
