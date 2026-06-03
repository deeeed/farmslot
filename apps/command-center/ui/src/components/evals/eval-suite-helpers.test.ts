import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRStatus, Run } from '@farmslot/protocol';

import {
  addCasesToBasket,
  buildCaseCatalog,
  canonicalSourceIdentity,
  catalogItemFromManual,
  datasetIdFor,
  datasetItemIdFor,
  filterCaseCatalog,
  findCatalogItemForPrRef,
  generatedCandidateVariant,
  normalizeGithubPrRef,
  selectedCaseFromCatalog,
  sortCaseCatalog,
} from './eval-suite-helpers.js';
import { buildLaunchCells, patchCell, summarizeLaunchCells } from './eval-suite-launch-model.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'owner/repo#1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'autonomous',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'farm',
    ticketOrPr: overrides.ticketOrPr ?? 'owner/repo#1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: overrides.createdAt ?? '2026-05-09T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-09T00:00:00.000Z',
    ...overrides,
  } as Run;
}

function makePr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: overrides.pr ?? 123,
    title: overrides.title ?? 'Fix checkout crash',
    summary: overrides.summary ?? null,
    repo: overrides.repo ?? 'owner/repo',
    headRef: overrides.headRef ?? 'fix/crash',
    project: overrides.project ?? 'farm',
    slot: overrides.slot ?? null,
    session: overrides.session ?? null,
    checks: overrides.checks ?? [],
    checkSummary: overrides.checkSummary ?? { passed: 0, failed: 0, pending: 0, total: 0 },
    allPassed: overrides.allPassed ?? true,
    anyFailed: overrides.anyFailed ?? false,
    failedNames: overrides.failedNames ?? [],
    botComments: overrides.botComments ?? [],
    actionableBotComments: overrides.actionableBotComments ?? [],
    prState: overrides.prState ?? 'MERGED',
    createdAt: overrides.createdAt ?? '2026-05-07T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-08T00:00:00.000Z',
    mergedAt: overrides.mergedAt ?? '2026-05-08T01:00:00.000Z',
    merged: overrides.merged ?? true,
    mergeable: overrides.mergeable ?? 'UNKNOWN',
    mergeConflict: overrides.mergeConflict ?? false,
    reviewDecision: overrides.reviewDecision ?? 'APPROVED',
    recommendation: overrides.recommendation ?? 'MERGED',
    ...overrides,
  } as PRStatus;
}

test('dataset ids are stable, order-insensitive, and exclude candidate axes', () => {
  const source = { kind: 'merged-pr' as const, ref: 'owner/repo#123' };
  const first = datasetItemIdFor({
    project: 'farm',
    source,
    taskProfile: 'fix-bug',
    objective: 'Fix crash',
  });
  const same = datasetItemIdFor({
    project: 'farm',
    source,
    taskProfile: 'fix-bug',
    objective: 'Fix crash',
  });
  const differentObjective = datasetItemIdFor({
    project: 'farm',
    source,
    taskProfile: 'fix-bug',
    objective: 'Fix login',
  });
  const differentProfile = datasetItemIdFor({
    project: 'farm',
    source,
    taskProfile: 'dev',
    objective: 'Fix crash',
  });
  const differentProject = datasetItemIdFor({
    project: 'other-farm',
    source,
    taskProfile: 'fix-bug',
    objective: 'Fix crash',
  });
  assert.equal(first, same);
  assert.notEqual(first, differentObjective);
  assert.notEqual(first, differentProfile);
  assert.notEqual(first, differentProject);
  assert.equal(
    datasetIdFor({ project: 'farm', datasetItemIds: [differentProfile, first] }),
    datasetIdFor({ project: 'farm', datasetItemIds: [first, differentProfile] }),
  );
});

test('case catalog exposes date metadata and sorts by recency', () => {
  const catalog = buildCaseCatalog({
    prs: [makePr({ pr: 123, title: 'Older merged PR', mergedAt: '2026-05-08T00:00:00.000Z' })],
    runs: [
      makeRun({ id: 'newer-run', summary: 'Newer run', completedAt: '2026-05-10T00:00:00.000Z' }),
      makeRun({ id: 'older-run', summary: 'Older run', completedAt: '2026-05-06T00:00:00.000Z' }),
    ],
  });
  assert.deepEqual(
    sortCaseCatalog(catalog, 'date', 'desc').map((item) => item.primary),
    ['Newer run', 'Older merged PR', 'Older run'],
  );
  assert.equal(catalog.find((item) => item.kind === 'merged-pr')?.primaryDateLabel, 'merged');
});

test('case catalog preview metadata links PRs, runs, diffs, and evidence counts', () => {
  const referenceRun = makeRun({
    id: 'run-preview',
    familyId: 'family-preview',
    ticketOrPr: 'owner/repo#123',
    links: [{ label: 'PR', url: 'https://github.com/owner/repo/pull/123' }],
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: {
          diffStat: { files: 3, additions: 20, deletions: 5 },
          artifacts: [
            { path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 1000 },
            { path: 'artifacts/report.md', purpose: 'report', sizeBytes: 2000 },
            { path: 'artifacts/review-feedback.md', purpose: 'review', sizeBytes: 3000 },
          ],
        },
      },
    ],
  });
  const catalog = buildCaseCatalog({
    prs: [makePr({ pr: 123, latestRunId: referenceRun.id, familyId: referenceRun.familyId })],
    runs: [referenceRun],
  });
  const prItem = catalog.find((item) => item.prNumber === 123);
  assert.equal(
    catalog.filter(
      (item) => item.source.kind === 'prior-run' && item.source.runId === referenceRun.id,
    ).length,
    1,
  );
  assert.equal(prItem?.kind, 'prior-run');
  assert.deepEqual(prItem?.source, { kind: 'prior-run', runId: 'run-preview' });
  assert.equal(prItem?.prUrl, 'https://github.com/owner/repo/pull/123');
  assert.equal(prItem?.sourceStatusLabel, 'PR merged · Farmslot run found');
  assert.equal(prItem?.runStatusLabel, 'run done');
  assert.equal(prItem?.suitabilityLabel, 'run-backed reference');
  assert.equal(prItem?.runHref, '#run/run-preview');
  assert.equal(prItem?.familyHref, '#family/family-preview?run=run-preview');
  assert.deepEqual(prItem?.diffStat, { files: 3, additions: 20, deletions: 5 });
  assert.equal(prItem?.artifactCount, 3);
  assert.equal(prItem?.artifactBytes, 6000);
  assert.equal(prItem?.visualEvidenceCount, 1);
  assert.equal(prItem?.validationEvidenceCount, 1);
  assert.equal(prItem?.reviewEvidenceCount, 1);
  assert.equal(
    findCatalogItemForPrRef(catalog, 'https://github.com/owner/repo/pull/123')?.sourceKey,
    prItem?.sourceKey,
  );
});

test('generated candidate variant is deterministic from selected dimensions', () => {
  assert.equal(
    generatedCandidateVariant({
      taskProfile: 'fix-bug',
      templateName: 'fix-bug.md',
      templateHash: 'abcdef123456',
      runner: 'codex',
      model: 'gpt-5.5',
    }),
    'fix-bug-codex-gpt-5-5-abcdef12',
  );
});

test('merged PR source identity does not reuse malformed refs as PR numbers', () => {
  assert.equal(
    canonicalSourceIdentity({ kind: 'merged-pr', ref: 'owner/repo' }),
    'merged-pr:owner/repo#',
  );
});

test('case catalog includes closed PRs only when gateway marks them merged', () => {
  const catalog = buildCaseCatalog({
    prs: [makePr({ pr: 789, prState: 'CLOSED', merged: true, recommendation: 'MERGED' })],
    runs: [],
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.selectable, true);
  assert.equal(catalog[0]?.sourceStatusLabel, 'PR merged · GitHub diff only');
  assert.deepEqual(catalog[0]?.warnings, []);
});

test('manual PR URL normalization lets exact entry prefer matching run-backed catalog item', () => {
  const referenceRun = makeRun({
    id: 'run-42292',
    project: 'example-browser-farm',
    ticketOrPr: 'example-org/example-browser#42292',
  });
  const catalog = buildCaseCatalog({
    prs: [
      makePr({
        pr: 42292,
        repo: 'example-org/example-browser',
        project: 'example-browser-farm',
        latestRunId: referenceRun.id,
        familyId: referenceRun.familyId,
      }),
    ],
    runs: [referenceRun],
  });
  assert.equal(
    normalizeGithubPrRef('https://github.com/example-org/example-browser/pull/42292'),
    'example-org/example-browser#42292',
  );
  const matched = findCatalogItemForPrRef(
    catalog,
    'https://github.com/example-org/example-browser/pull/42292',
  );
  assert.equal(matched?.source.kind, 'prior-run');
  assert.equal(matched?.runId, 'run-42292');
});

test('PR URL search matches existing prior-run rows even without hydrated PR data', () => {
  const catalog = buildCaseCatalog({
    prs: [],
    runs: [
      makeRun({
        id: 'run-42292',
        project: 'example-browser-farm',
        prNumber: 42292,
        ticketOrPr: 'PROJ-3075',
      }),
    ],
  });
  const matches = filterCaseCatalog(catalog, {
    query: 'https://github.com/example-org/example-browser/pull/42292',
    kind: 'prior-run',
    project: 'all',
    taskProfile: 'all',
    status: 'all',
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].runId, 'run-42292');
  assert.equal(
    findCatalogItemForPrRef(catalog, 'https://github.com/example-org/example-browser/pull/42292')
      ?.runId,
    'run-42292',
  );
});

test('case catalog hides closed PRs that were not merged', () => {
  const catalog = buildCaseCatalog({
    prs: [
      makePr({ pr: 790, prState: 'CLOSED', merged: false, recommendation: 'CLOSED_WITHOUT_MERGE' }),
    ],
    runs: [],
  });
  assert.equal(catalog.length, 0);
});

test('case catalog uses hydrated PRs/runs and filters without global search', () => {
  const catalog = buildCaseCatalog({
    project: 'farm',
    prs: [makePr({ pr: 123, title: 'Fix checkout crash' }), makePr({ pr: 456, project: 'other' })],
    runs: [makeRun({ id: 'run-dev', flowType: 'dev', summary: 'Build import wizard' })],
  });
  assert.equal(catalog.length, 2);
  assert.equal(
    catalog.some((item) => item.project === 'other'),
    false,
  );
  assert.deepEqual(
    filterCaseCatalog(catalog, {
      query: 'checkout',
      kind: 'all',
      project: 'all',
      taskProfile: 'all',
      status: 'all',
    }).map((item) => item.kind),
    ['merged-pr'],
  );
  assert.equal(
    filterCaseCatalog(catalog, {
      query: '',
      kind: 'prior-run',
      project: 'all',
      taskProfile: 'dev',
      status: 'all',
    }).map((item) => item.id).length,
    1,
  );
  assert.equal(
    catalog.some((item) => item.source.kind === 'prior-run' && item.source.runId === 'run-active'),
    false,
  );
  assert.equal(
    catalog.some((item) => item.source.kind === 'prior-run' && item.source.runId === 'run-review'),
    false,
  );
});

test('manual entries and basket dedupe by dataset item id', () => {
  const manual = catalogItemFromManual({
    kind: 'git-ref',
    project: 'farm',
    taskProfile: 'dev',
    gitRef: 'abc123',
    gitRepository: 'owner/repo',
    objective: 'Implement feature',
  });
  const sameSourceOtherProject = catalogItemFromManual({
    kind: 'git-ref',
    project: 'other-farm',
    taskProfile: 'dev',
    gitRef: 'abc123',
    gitRepository: 'owner/repo',
    objective: 'Implement feature',
  });
  assert.ok(manual);
  assert.ok(sameSourceOtherProject);
  const selected = selectedCaseFromCatalog(manual!);
  const basket = addCasesToBasket([selected], [manual!, sameSourceOtherProject!]);
  assert.equal(basket.length, 2);
  assert.equal(basket[0].datasetItemId, selected.datasetItemId);
  assert.notEqual(basket[0].datasetItemId, basket[1].datasetItemId);
});

test('launch matrix and summary aggregate operational fields only', () => {
  const manual = catalogItemFromManual({
    kind: 'package',
    project: 'farm',
    taskProfile: 'fix-bug',
    packagePath: '/tmp/reference.result-package.json',
  });
  assert.ok(manual);
  const selected = selectedCaseFromCatalog(manual!);
  const cells = buildLaunchCells(
    [selected],
    [
      { id: 'control', label: 'current', enabled: true },
      { id: 'disabled', label: 'disabled', enabled: false },
    ],
  );
  assert.equal(cells.length, 1);
  const patched = patchCell(cells, cells[0].cellId, {
    status: 'final',
    durationMs: 1000,
    costEstimate: 1.25,
    validationEvidenceCount: 2,
    visualEvidenceCount: 1,
    missingData: ['visual-evidence-missing'],
  });
  const summary = summarizeLaunchCells(patched);
  assert.equal(summary.total, 1);
  assert.equal(summary.counts.final, 1);
  assert.equal(summary.durationMs, 1000);
  assert.equal(summary.costEstimate, 1.25);
  assert.equal(summary.validationEvidenceCount, 2);
  assert.equal(summary.missingDataCount, 1);
});
