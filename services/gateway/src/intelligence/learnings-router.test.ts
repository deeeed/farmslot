import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LearningsDraftPayload, Run } from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  __setAntipatternDrafterForTest,
  __setLearningsClassifierForTest,
  antipatternTargetPath,
  classifyLearningsEntries,
  emitLearningsDraftDecision,
  routeLearnings,
  splitLearningsEntries,
} from './learnings-router.js';

const TEST_PROJECT = `.learnings-router-test-${process.pid}`;
const TEST_PROJECT_DIR = path.join(farmslotRoot, 'projects', TEST_PROJECT);

function setupProject(options: { repoKey?: string } = {}): void {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  const vars = options.repoKey ? { antipattern_repo_key: options.repoKey } : {};
  writeFileSync(
    path.join(TEST_PROJECT_DIR, 'project.json'),
    `${JSON.stringify({ name: TEST_PROJECT, vars })}\n`,
  );
  invalidateProjectVarsCache(TEST_PROJECT);
}

function teardownProject(): void {
  rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  invalidateProjectVarsCache(TEST_PROJECT);
}

async function cleanupRun(runId: string): Promise<void> {
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

// Real mixed fixture shape from run 075eccd8 / TAT-3462: bold-lead bullets with
// continuation lines; the last one is the SYSTEM finding.
const MIXED_LEARNINGS = `# TAT-3462 — Learnings

- **\`Performance.getMetrics\` is not a retention measurement.** \`Nodes\` counts
  objects that are unreachable but not yet collected; forcing GC before each
  sample turned +454 nodes/cycle into +0.
- **The task template's recipe schema was stale.** It describes
  schema_version/pre_conditions/nodes, but mm-harness enforces recipe-v1.
`;

test('splitLearningsEntries handles bold-lead bullets, continuations, sections, and bare prose', () => {
  const entries = splitLearningsEntries(
    `# Heading\n\n## Original fix-bug learnings (run abc)\n- first bullet\n  continued line\n- second bullet\n\n## Reviewer comments summary\ntotal=3 real=1 fixed=1\n`,
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0]?.section, 'Original fix-bug learnings (run abc)');
  assert.equal(entries[0]?.text, '- first bullet\n  continued line');
  assert.equal(entries[1]?.text, '- second bullet');
  // Prose without bullets is preserved as an entry, never dropped.
  assert.equal(entries[2]?.section, 'Reviewer comments summary');
  assert.equal(entries[2]?.text, 'total=3 real=1 fixed=1');
});

test('heuristic system entries never reach the LLM classifier', async (t) => {
  const seen: string[] = [];
  __setLearningsClassifierForTest(async (entries) => {
    entries.forEach((entry) => seen.push(entry.text));
    return entries.map(() => 'domain' as const);
  });
  t.after(() => __setLearningsClassifierForTest(null));

  const buckets = await classifyLearningsEntries(splitLearningsEntries(MIXED_LEARNINGS));
  assert.equal(buckets.system.length, 1);
  assert.match(buckets.system[0]!.text, /recipe schema was stale/);
  assert.equal(buckets.domain.length, 1);
  assert.equal(seen.length, 1, 'only the non-heuristic entry consults the classifier');
});

test('classifier failure holds entries as unclassified instead of dropping or guessing', async (t) => {
  __setLearningsClassifierForTest(async () => {
    throw new Error('boom');
  });
  t.after(() => __setLearningsClassifierForTest(null));

  const buckets = await classifyLearningsEntries(
    splitLearningsEntries('- some ambiguous observation about timing\n'),
  );
  assert.equal(buckets.unclassified.length, 1);
  assert.equal(buckets.system.length + buckets.domain.length, 0);
});

test('AC1: a mixed fixture yields exactly one system arm and one domain draft — never both, never zero', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  __setAntipatternDrafterForTest(async (entries) =>
    entries.map(() => ({
      id: 'forced-gc-before-node-counts',
      symptom: 'node counts look like a leak',
      cause: 'uncollected garbage inflates Performance.getMetrics',
      action: 'force HeapProfiler.collectGarbage before each sample',
    })),
  );
  t.after(() => {
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
  });

  const routed = await routeLearnings(TEST_PROJECT, MIXED_LEARNINGS);
  assert.equal(routed.buckets.system.length, 1);
  assert.equal(routed.drafts.length, 1);
  assert.equal(routed.holds.length, 0);
  assert.ok(routed.systemContent);
  assert.match(routed.systemContent!, /recipe schema was stale/);
  assert.doesNotMatch(routed.systemContent!, /Performance\.getMetrics/);
  assert.equal(
    routed.drafts[0]!.targetPath,
    antipatternTargetPath('testrepo', 'forced-gc-before-node-counts'),
  );
  assert.match(
    routed.drafts[0]!.targetPath,
    /^domains\/agentic\/skills\/recipe-pr-qa-review\/references\/antipatterns\/testrepo\//,
  );
  assert.match(routed.drafts[0]!.sourceEntry, /Performance\.getMetrics/);
});

test('AC2: a domain entry with no configured repo-key becomes a teaching hold, not a guessed path', async (t) => {
  setupProject({});
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  __setAntipatternDrafterForTest(async () => {
    throw new Error('drafter must not run without a repo-key');
  });
  t.after(() => {
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
  });

  const routed = await routeLearnings(TEST_PROJECT, '- product screens flake on slow seeds\n');
  assert.equal(routed.drafts.length, 0);
  assert.equal(routed.holds.length, 1);
  assert.match(routed.holds[0]!.reason, /vars\.antipattern_repo_key/);
  assert.equal(routed.systemContent, null);
});

test('AC3: a draft the drafter cannot shape faithfully is held, and slugs are validated', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  __setAntipatternDrafterForTest(async (entries) =>
    entries.map((_, index) =>
      index === 0 ? { id: 'INVALID SLUG!', symptom: 's', cause: 'c', action: 'a' } : null,
    ),
  );
  t.after(() => {
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
  });

  const routed = await routeLearnings(
    TEST_PROJECT,
    '- first domain lesson\n\n- second domain lesson\n',
  );
  assert.equal(routed.drafts.length, 0);
  assert.equal(routed.holds.length, 2);
});

test('AC5: emitting a draft appends exactly one processed.jsonl receipt per captured package', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  const inbox = mkdtempSync(path.join(tmpdir(), 'lrn-inbox-'));
  const ticket = 'LRN-42';
  mkdirSync(path.join(inbox, 'indexes', 'by-ticket'), { recursive: true });
  writeFileSync(
    path.join(inbox, 'indexes', 'by-ticket', `${ticket.toLowerCase()}.jsonl`),
    `${JSON.stringify({ packageId: 'pkg-0001', taskKey: 'lrn-42', ticket })}\n`,
  );
  process.env.FARMSLOT_LEARNINGS_INBOX = inbox;
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  __setAntipatternDrafterForTest(async (entries) =>
    entries.map(() => ({ id: 'slow-seed-flake', symptom: 's', cause: 'c', action: 'a' })),
  );
  const run = createRun({ flowType: 'dev', project: TEST_PROJECT, ticketOrPr: ticket });
  t.after(async () => {
    delete process.env.FARMSLOT_LEARNINGS_INBOX;
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
    await cleanupRun(run.id);
    rmSync(inbox, { recursive: true, force: true });
  });

  const routed = await routeLearnings(TEST_PROJECT, '- product screens flake on slow seeds\n');
  const firstDecision = await emitLearningsDraftDecision(run.id, routed);
  assert.ok(firstDecision);
  const secondDecision = await emitLearningsDraftDecision(run.id, routed);
  assert.ok(secondDecision);

  const processed = await readFile(path.join(inbox, 'indexes', 'processed.jsonl'), 'utf-8');
  const lines = processed.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 1, 'receipt must be appended exactly once');
  const record = JSON.parse(lines[0]!);
  assert.equal(record.packageId, 'pkg-0001');
  assert.equal(record.outcome, 'proposal');
  assert.match(record.link, new RegExp(`run:${run.id}`));

  const runState = getRun(run.id) as Run;
  const decisions = (runState.decisions ?? []).filter(
    (decision) => decision.type === 'engine_learnings_draft',
  );
  assert.equal(decisions.length, 2);
  const firstPayload = decisions[0]!.payload as LearningsDraftPayload;
  const secondPayload = decisions[1]!.payload as LearningsDraftPayload;
  assert.equal(firstPayload.receipt?.status, 'appended');
  assert.equal(secondPayload.receipt?.status, 'already-processed');
  // Every route terminates at a human gate: dismiss only, no auto-merge arm.
  assert.deepEqual(
    decisions.map((decision) => decision.actions.map((action) => action.id)),
    [['dismiss'], ['dismiss']],
  );
});

test('no inbox configured yields an explicit skipped receipt, and nothing is dropped end-to-end', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  delete process.env.FARMSLOT_LEARNINGS_INBOX;
  __setLearningsClassifierForTest(async (entries) =>
    entries.map((entry) =>
      entry.text.includes('ambiguous') ? ('unclassified' as const) : ('domain' as const),
    ),
  );
  __setAntipatternDrafterForTest(async (entries) =>
    entries.map(() => ({ id: 'seed-trap', symptom: 's', cause: 'c', action: 'a' })),
  );
  const run = createRun({ flowType: 'dev', project: TEST_PROJECT, ticketOrPr: 'LRN-43' });
  t.after(async () => {
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
    await cleanupRun(run.id);
  });

  const routed = await routeLearnings(
    TEST_PROJECT,
    '- a domain seeding trap\n\n- something ambiguous about timing\n',
  );
  // Conservation: every entry lands in exactly one bucket.
  assert.equal(routed.drafts.length + routed.holds.length, 2);
  assert.equal(routed.drafts.length, 1);
  assert.equal(routed.holds.length, 1);

  const decisionId = await emitLearningsDraftDecision(run.id, routed);
  assert.ok(decisionId);
  const payload = (getRun(run.id)!.decisions ?? []).find((d) => d.id === decisionId)!
    .payload as LearningsDraftPayload;
  assert.equal(payload.receipt?.status, 'skipped');
  assert.match(
    payload.receipt && 'reason' in payload.receipt ? payload.receipt.reason : '',
    /no learnings inbox configured/,
  );
});
