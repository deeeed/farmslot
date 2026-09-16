import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LearningsDraftPayload } from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { feedbackLedgerPath, readFeedbackLedger } from './feedback-ledger.js';
import {
  __setAntipatternDrafterForTest,
  __setLearningsClassifierForTest,
  appendProcessedReceipt,
  classifyLearningsEntries,
  emitLearningsDraftDecision,
  knowledgeDestinationFromConfig,
  recordLearningsDraftLanded,
  routeLearnings,
  splitLearningsEntries,
} from './learnings-router.js';

const TEST_PROJECT = `.learnings-router-test-${process.pid}`;
const TEST_PROJECT_DIR = path.join(farmslotRoot, 'projects', TEST_PROJECT);

const TEST_LIBRARY_REPO = 'git@github.com:example/recipe-library.git';

function setupProject(options: { repoKey?: string } = {}): void {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  // The destination is the library the static reviewer already consumes.
  const config = options.repoKey
    ? {
        name: TEST_PROJECT,
        static_review: {
          support: {
            libraries: [{ name: options.repoKey, root: { env: 'LRN_TEST_LIBRARY_ROOT' } }],
          },
        },
        reference_repos: { [`${options.repoKey}_library`]: { repo_url: TEST_LIBRARY_REPO } },
      }
    : { name: TEST_PROJECT };
  writeFileSync(path.join(TEST_PROJECT_DIR, 'project.json'), `${JSON.stringify(config)}\n`);
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
  // Canonical routing: the draft targets the library the static reviewer consumes.
  assert.equal(routed.drafts[0]!.targetPath, 'review/antipatterns.md');
  assert.equal(routed.drafts[0]!.targetRepo, TEST_LIBRARY_REPO);
  assert.deepEqual(routed.destination, {
    repo: TEST_LIBRARY_REPO,
    path: 'review/antipatterns.md',
    library: 'testrepo',
    source: 'static_review',
  });
  assert.match(routed.drafts[0]!.sourceEntry, /Performance\.getMetrics/);
});

test('AC2: a domain entry with no configured destination becomes a teaching hold, not a guessed path', async (t) => {
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
  assert.match(routed.holds[0]!.reason, /vars\.knowledge_destination/);
  assert.equal(routed.systemContent, null);
  assert.equal(routed.destination, null);
});

test('knowledge destination comes from config only: explicit vars win, static_review derives, nothing else guesses', () => {
  assert.deepEqual(
    knowledgeDestinationFromConfig({
      vars: {
        knowledge_destination: { repo: 'git@x:o/r.git', path: 'review/antipatterns.extension.md' },
      },
      static_review: { support: { libraries: [{ name: 'perps' }] } },
      reference_repos: { perps_library: { repo_url: 'git@x:o/lib.git' } },
    }),
    {
      repo: 'git@x:o/r.git',
      path: 'review/antipatterns.extension.md',
      source: 'vars.knowledge_destination',
    },
  );
  assert.deepEqual(
    knowledgeDestinationFromConfig({
      static_review: { support: { libraries: [{ name: 'perps' }] } },
      reference_repos: { perps_library: { repo_url: 'git@x:o/lib.git' } },
    }),
    {
      repo: 'git@x:o/lib.git',
      path: 'review/antipatterns.md',
      library: 'perps',
      source: 'static_review',
    },
  );
  // A library without a matching reference repo cannot be a destination.
  assert.equal(
    knowledgeDestinationFromConfig({
      static_review: { support: { libraries: [{ name: 'perps' }] } },
    }),
    null,
  );
  // A malformed explicit destination is rejected rather than falling back silently.
  assert.equal(
    knowledgeDestinationFromConfig({
      vars: { knowledge_destination: { repo: 'x' } },
      static_review: { support: { libraries: [{ name: 'perps' }] } },
      reference_repos: { perps_library: { repo_url: 'git@x:o/lib.git' } },
    }),
    null,
  );
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

  // Restart-recovery re-emission: while the first card is open, a second emit
  // must return the SAME card instead of stacking a duplicate.
  const duplicateEmit = await emitLearningsDraftDecision(run.id, routed);
  assert.equal(duplicateEmit, firstDecision);
  let decisions = (getRun(run.id)!.decisions ?? []).filter(
    (decision) => decision.type === 'engine_learnings_draft',
  );
  assert.equal(decisions.length, 1, 'open card must not be duplicated');

  // Dismissing re-arms emission; the receipt dedupe still holds package-wide.
  updateRun(run.id, {
    decisions: (getRun(run.id)!.decisions ?? []).map((decision) =>
      decision.id === firstDecision
        ? { ...decision, resolvedAt: new Date().toISOString(), resolvedAction: 'dismiss' }
        : decision,
    ),
  });
  const thirdDecision = await emitLearningsDraftDecision(run.id, routed);
  assert.ok(thirdDecision && thirdDecision !== firstDecision);

  const processed = await readFile(path.join(inbox, 'indexes', 'processed.jsonl'), 'utf-8');
  const lines = processed.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 1, 'receipt must be appended exactly once');
  const record = JSON.parse(lines[0]!);
  assert.equal(record.packageId, 'pkg-0001');
  assert.equal(record.outcome, 'proposal');
  assert.match(record.link, new RegExp(`run:${run.id}`));

  decisions = (getRun(run.id)!.decisions ?? []).filter(
    (decision) => decision.type === 'engine_learnings_draft',
  );
  assert.equal(decisions.length, 2);
  const firstPayload = decisions[0]!.payload as LearningsDraftPayload;
  const thirdPayload = decisions[1]!.payload as LearningsDraftPayload;
  assert.equal(firstPayload.receipt?.status, 'appended');
  assert.equal(thirdPayload.receipt?.status, 'already-processed');
  // Every route terminates at a human gate: record-as-landed or dismiss, no auto-merge arm.
  assert.deepEqual(
    decisions.map((decision) => decision.actions.map((action) => action.id)),
    [
      ['landed', 'dismiss'],
      ['landed', 'dismiss'],
    ],
  );
});

test('approval gating: "landed" binds the family feedback to the draft in the ledger, idempotently', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  const ledgerDir = mkdtempSync(path.join(tmpdir(), 'lrn-ledger-'));
  process.env.FARMSLOT_FEEDBACK_LEDGER = path.join(ledgerDir, 'feedback-ledger.json');
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  __setAntipatternDrafterForTest(async (entries) =>
    entries.map(() => ({ id: 'unknown-balance-as-zero', symptom: 's', cause: 'c', action: 'a' })),
  );
  const run = createRun({ flowType: 'pr-complete', project: TEST_PROJECT, ticketOrPr: 'o/r#7' });
  t.after(async () => {
    delete process.env.FARMSLOT_FEEDBACK_LEDGER;
    __setLearningsClassifierForTest(null);
    __setAntipatternDrafterForTest(null);
    teardownProject();
    await cleanupRun(run.id);
    rmSync(ledgerDir, { recursive: true, force: true });
  });

  const candidate = {
    id: 'cand-1',
    sourceKey: 'github.com/o/r#7:review-comment:11',
    provider: 'github' as const,
    repository: 'o/r',
    prNumber: 7,
    kind: 'review-comment' as const,
    revision: 'rev-a',
    bodyRevision: 'body-a',
    authorKind: 'human' as const,
    resolution: { state: 'open' as const },
    runIds: ['other-run'],
    familyChangeRunIds: [],
    attribution: { kind: 'unknown' as const, note: 'n' },
    sources: ['comments-triage' as const],
  };
  const routed = await routeLearnings(TEST_PROJECT, '- unknown balance rendered as zero\n');
  const decisionId = await emitLearningsDraftDecision(run.id, routed, {
    feedbackCandidates: [candidate],
  });
  assert.ok(decisionId);
  const decision = getRun(run.id)!.decisions.find((entry) => entry.id === decisionId)!;
  assert.equal(decision.actions[0]?.id, 'landed');

  const added = await recordLearningsDraftLanded(run, decision);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.rule, 'unknown-balance-as-zero');
  assert.equal(added[0]!.destination, `${TEST_LIBRARY_REPO}:review/antipatterns.md`);
  assert.equal(added[0]!.sourceKey, candidate.sourceKey);
  assert.deepEqual(added[0]!.runIds, [run.id, 'other-run']);
  // A retried approval records nothing new.
  assert.equal((await recordLearningsDraftLanded(run, decision)).length, 0);
  const ledger = await readFeedbackLedger(feedbackLedgerPath());
  assert.equal(ledger.entries.length, 1);
});

test('a card with no destination never offers the landed action and refuses to record', async (t) => {
  setupProject({});
  __setLearningsClassifierForTest(async (entries) => entries.map(() => 'domain' as const));
  const run = createRun({ flowType: 'dev', project: TEST_PROJECT, ticketOrPr: 'LRN-9' });
  t.after(async () => {
    __setLearningsClassifierForTest(null);
    teardownProject();
    await cleanupRun(run.id);
  });
  const routed = await routeLearnings(TEST_PROJECT, '- some domain lesson\n');
  const decisionId = await emitLearningsDraftDecision(run.id, routed);
  const decision = getRun(run.id)!.decisions.find((entry) => entry.id === decisionId)!;
  assert.deepEqual(
    decision.actions.map((action) => action.id),
    ['dismiss'],
  );
  await assert.rejects(() => recordLearningsDraftLanded(run, decision), /no canonical destination/);
});

test('concurrent receipt appends stay exactly-once under the inbox lock', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  const inbox = mkdtempSync(path.join(tmpdir(), 'lrn-inbox-race-'));
  const ticket = 'LRN-77';
  mkdirSync(path.join(inbox, 'indexes', 'by-ticket'), { recursive: true });
  writeFileSync(
    path.join(inbox, 'indexes', 'by-ticket', `${ticket.toLowerCase()}.jsonl`),
    `${JSON.stringify({ packageId: 'pkg-race', taskKey: 'lrn-77', ticket })}\n`,
  );
  process.env.FARMSLOT_LEARNINGS_INBOX = inbox;
  const run = createRun({ flowType: 'dev', project: TEST_PROJECT, ticketOrPr: ticket });
  t.after(async () => {
    delete process.env.FARMSLOT_LEARNINGS_INBOX;
    teardownProject();
    await cleanupRun(run.id);
    rmSync(inbox, { recursive: true, force: true });
  });

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => appendProcessedReceipt(run, `dec-${index}`)),
  );
  const appended = results.filter((receipt) => receipt.status === 'appended');
  const deduped = results.filter((receipt) => receipt.status === 'already-processed');
  assert.equal(appended.length, 1, 'exactly one concurrent caller may append');
  assert.equal(deduped.length, 4);
  const processed = await readFile(path.join(inbox, 'indexes', 'processed.jsonl'), 'utf-8');
  assert.equal(processed.split('\n').filter((line) => line.trim()).length, 1);
});

test('a stale inbox lock from a crashed holder is taken over instead of blocking receipts', async (t) => {
  setupProject({ repoKey: 'testrepo' });
  const inbox = mkdtempSync(path.join(tmpdir(), 'lrn-inbox-stale-'));
  const ticket = 'LRN-88';
  mkdirSync(path.join(inbox, 'indexes', 'by-ticket'), { recursive: true });
  writeFileSync(
    path.join(inbox, 'indexes', 'by-ticket', `${ticket.toLowerCase()}.jsonl`),
    `${JSON.stringify({ packageId: 'pkg-stale', taskKey: 'lrn-88', ticket })}\n`,
  );
  // Simulate a crashed holder: lock directory whose mtime is minutes old.
  const lockDir = path.join(inbox, 'indexes', '.processed.jsonl.lock');
  mkdirSync(lockDir, { recursive: true });
  const oldTime = new Date(Date.now() - 5 * 60_000);
  utimesSync(lockDir, oldTime, oldTime);
  process.env.FARMSLOT_LEARNINGS_INBOX = inbox;
  const run = createRun({ flowType: 'dev', project: TEST_PROJECT, ticketOrPr: ticket });
  t.after(async () => {
    delete process.env.FARMSLOT_LEARNINGS_INBOX;
    teardownProject();
    await cleanupRun(run.id);
    rmSync(inbox, { recursive: true, force: true });
  });

  const receipt = await appendProcessedReceipt(run, 'dec-stale');
  assert.equal(receipt.status, 'appended');
});

test('CRLF blobs and asterisk bullets split cleanly', () => {
  const entries = splitLearningsEntries('- unix bullet\r\n  continued\r\n\r\n* star bullet\r\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.text, '- unix bullet\n  continued');
  assert.equal(entries[1]?.text, '* star bullet');
  assert.doesNotMatch(entries[0]!.text, /\r/);
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
