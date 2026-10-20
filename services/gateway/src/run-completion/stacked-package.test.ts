import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { ReviewStatus, Run, RunStack } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { RecordedEvidenceSource } from '../run-engine/recorded-evidence-sources.js';
import { makeVars } from '../runners/test-fixtures.js';

import { makeRun, manualTicketData } from './test-fixtures.js';

const nativeConfig = await import('../core/config.js');
const nativeExec = await import('../core/exec.js');
const nativeStore = await import('../runs/store.js');
const nativeMirror = await import('./artifact-mirror.js');
const nativeSession = await import('../runners/session-process.js');
const nativeTemplate = await import('./pr-template.js');
const nativeGithub = await import('../integrations/github-client.js');
let run: Run;
let lineageParent: Run | null = null;
let repo = '';
const templateBases: string[] = [];
let mirrorCopied = 1;
let githubRequests = 0;
let mirrorOptions: Parameters<typeof nativeMirror.refreshArtifactMirror>[1];
const vars = () =>
  makeVars({ slotId: 'stack-fixture', projectName: 'stack-fixture', remoteRepo: repo, repo });
mock.module('../core/config.js', {
  namedExports: {
    ...nativeConfig,
    loadSlotVars: async () => vars(),
    loadProjectVars: async () => ({
      projectJson: {
        name: 'stack-fixture',
        default_branch: 'main',
        ci: { repo: 'fixture/stacked-package' },
        paths: { artifact_dir: '.task' },
      },
      runtimeDir: '.agent',
      artifactDir: '.task',
    }),
  },
});
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...nativeGithub,
    ghRequest: async () => {
      githubRequests++;
      throw new Error('Publication must refuse before contacting GitHub');
    },
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    execOnSlot: async (_vars: unknown, command: string) => {
      assert.ok(!command.includes('tmux'), 'the fixture never invokes a real runner');
      return nativeExec.execLocal(command, { cwd: repo });
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...nativeStore,
    getRun: () => run,
    getRunWithArchived: async (id: string) =>
      id === lineageParent?.id ? lineageParent : id === run?.id ? run : null,
    updateRun: (_id: string, patch: Partial<Run>) => (run = { ...run, ...patch }),
    // The native store fences writes against its own map, which this fixture replaces.
    persistRunNow: async (record: Run) => {
      await mkdir(nativeStore.runsDirectory(), { recursive: true });
      await writeFile(
        path.join(nativeStore.runsDirectory(), `${record.id}.json`),
        JSON.stringify(record),
      );
    },
  },
});
mock.module('./artifact-mirror.js', {
  namedExports: {
    ...nativeMirror,
    refreshArtifactMirror: async (_run: Run, options: typeof mirrorOptions) => {
      mirrorOptions = options;
      return mirrorCopied;
    },
  },
});
mock.module('../runners/session-process.js', {
  namedExports: { ...nativeSession, resolveRunnerSessionForRun: async () => null },
});
const nativeDraft = await import('./draft-pr.js');
mock.module('./draft-pr.js', {
  namedExports: { ...nativeDraft, buildDraftPrBody: async () => '## Summary\nChild fix\n' },
});
mock.module('./pr-template.js', {
  namedExports: {
    ...nativeTemplate,
    conformRunPrBodyToTemplate: async (_run: Run, body: string, base: string) => {
      templateBases.push(base);
      return { body, added: [], outOfOrder: [] };
    },
  },
});
// The package's evidence readers and its visual stamping, scripted only when a case sets them.
const nativeEvidence = await import('../run-engine/recorded-evidence-sources.js');
let scriptedEvidence: {
  publication: RecordedEvidenceSource[];
  selected: RecordedEvidenceSource[];
  publicationKeys: (readonly string[] | undefined)[];
} | null = null;
mock.module('../run-engine/recorded-evidence-sources.js', {
  namedExports: {
    ...nativeEvidence,
    readFrozenPublicationRecipeSources: async (
      ...args: Parameters<typeof nativeEvidence.readFrozenPublicationRecipeSources>
    ) => {
      if (!scriptedEvidence) return nativeEvidence.readFrozenPublicationRecipeSources(...args);
      scriptedEvidence.publicationKeys.push(args[2]);
      return scriptedEvidence.publication;
    },
    readFrozenRecordedEvidenceSources: async (
      ...args: Parameters<typeof nativeEvidence.readFrozenRecordedEvidenceSources>
    ) =>
      scriptedEvidence
        ? scriptedEvidence.selected
        : nativeEvidence.readFrozenRecordedEvidenceSources(...args),
  },
});
const nativeVisual = await import('../review/pipeline-visual-review.js');
const stampedSources: (readonly RecordedEvidenceSource[])[] = [];
mock.module('../review/pipeline-visual-review.js', {
  namedExports: {
    ...nativeVisual,
    stampPipelineVisualReviews: async (
      ...args: Parameters<typeof nativeVisual.stampPipelineVisualReviews>
    ) => {
      if (!scriptedEvidence) return nativeVisual.stampPipelineVisualReviews(...args);
      stampedSources.push(args[1]);
    },
  },
});
const {
  assertReadyGatePackageInputsCurrent,
  prepareCompletionPackage,
  publishCompletionPackage,
  renderCurrentDescription,
  runCompletionPipeline,
} = await import('./orchestrator.js');
const { publicationBaseForRun, stackPrBase } = await import('../run-engine/stack-base.js');
const { parseGitNumstat } = await import('../run-engine/diff-artifacts.js');
const { captureCurrentReviewSnapshot } = await import('../review/snapshots.js');
const { assertPublicationReviewPolicySatisfied } = await import('../run-engine/gate-policy.js');

let root = '';
let git: (...args: string[]) => string;
let parentSha = '';
let headSha = '';
let taskFile = '';
let stack: RunStack;
const parentDiff = { files: 9, additions: 281, deletions: 51 };
const fullDiff = { files: 18, additions: 687, deletions: 116 };
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
// Disjoint parent/child edits reproduce 18 files +687/-116 versus 9 files +281/-51.
async function prepareFixture() {
  root = await mkdtemp(path.join(tmpdir(), 'stacked-package-'));
  repo = path.join(root, 'repo');
  const remote = path.join(root, 'origin.git');
  await mkdir(repo);
  git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  const files = async (group: string, count: number, version: string) => {
    await mkdir(path.join(repo, 'src', group), { recursive: true });
    for (let i = 0; i < 9; i++) {
      const n = Math.floor(count / 9) + Number(i < count % 9);
      await writeFile(
        path.join(repo, 'src', group, `${i}.ts`),
        Array.from({ length: n }, (_, j) => `${version}-${i}-${j}\n`).join(''),
      );
    }
  };
  await files('parent', 65, 'old-parent');
  await files('child', 51, 'old-child');
  git('add', '.');
  git('commit', '-qm', 'test: seed');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature/parent');
  await files('parent', 406, 'new-parent');
  git('add', '.');
  git('commit', '-qm', 'test: parent');
  git('push', '-q', 'origin', 'feature/parent');
  parentSha = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'fix/child');
  await files('child', 281, 'new-child');
  git('add', '.');
  git('commit', '-qm', 'test: child');
  headSha = git('rev-parse', 'HEAD');
  const taskDir = path.join(root, 'task');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  taskFile = path.join(taskDir, 'TASK.md');
  await writeFile(taskFile, '# Child task\n');
  await writeFile(path.join(taskDir, 'artifacts', 'pr-description.md'), 'Child fix\n');
  stack = {
    upstreamNodeId: 'parent-node',
    upstreamRunId: 'parent-run',
    upstreamPrNumber: 7,
    baseBranch: 'feature/parent',
    resolvedSha: parentSha,
  };
  assert.deepEqual(parseGitNumstat(git('diff', '--numstat', 'origin/main', 'HEAD')), fullDiff);
  assert.deepEqual(
    parseGitNumstat(git('diff', '--numstat', 'origin/feature/parent', 'HEAD')),
    parentDiff,
  );
  // Prepare the fixture's baseline before timed cases, including lazy completion imports.
  resetRun();
  await prepareCompletionPackage(run.id, {
    diffStat: fullDiff,
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
}

function resetRun(currentStack?: RunStack) {
  lineageParent = null;
  run = {
    ...makeRun({
      id: 'stack-fixture',
      flowType: 'dev',
      mode: 'autonomous',
      project: 'stack-fixture',
      taskFile,
      slotId: 'stack-fixture',
      branch: 'fix/child',
      ticketData: manualTicketData('Child fix'),
    }),
    stack: currentStack,
    prNumber: undefined,
  };
  templateBases.length = 0;
}

// The file's elapsed time includes setup; each case times its assertions separately.
await prepareFixture();

test('a required publish mirror accepts zero transfers and forwards publication preflight', async (t) => {
  resetRun();
  mirrorCopied = 0;
  t.after(() => {
    mirrorCopied = 1;
  });
  const completion = await prepareCompletionPackage(run.id, {
    requireArtifactMirror: true,
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });
  assert.equal(completion.completion.artifactsCopied, true);
  assert.equal(completion.prPackage.headSha, headSha);
  assert.equal(mirrorOptions?.requireSourceArtifacts, true);
  assert.equal(mirrorOptions?.forPublication, true);
});

test('no-code completion mirrors without requesting publication preflight', async () => {
  resetRun();
  run.recordedEvidenceContractVersion = 1;
  run.metrics.disposition = 'already_fixed';
  const completion = await runCompletionPipeline(run.id, {
    suppressPrMutation: true,
    skipRetrospective: true,
  });
  assert.equal(completion.artifactsCopied, true);
  assert.notEqual(mirrorOptions?.forPublication, true);
});

test('stacked package and preview exclude the upstream nine files', async () => {
  resetRun(stack);
  const stacked = (
    await prepareCompletionPackage(run.id, {
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(stacked.reviewSnapshot?.baseRef, 'origin/feature/parent');
  assert.equal(stacked.reviewSnapshot?.baseSha, parentSha);
  assert.equal(stacked.reviewSnapshot?.headSha, headSha);
  assert.deepEqual(stacked.reviewSnapshot?.diffStat, parentDiff);
  assert.deepEqual(stacked.diffStat, parentDiff);
  assert.equal(templateBases.at(-1), await publicationBaseForRun(run, 'main'));
  await renderCurrentDescription(run, stacked);
  assert.equal(templateBases.at(-1), 'feature/parent');
});

test('standalone publication keeps the default 18-file package', async () => {
  // Standalone runs retain the configured default and the complete 18-file diff.
  resetRun();
  const standalone = (
    await prepareCompletionPackage(run.id, {
      diffStat: fullDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(standalone.reviewSnapshot?.baseRef, 'origin/main');
  assert.deepEqual(standalone.reviewSnapshot?.diffStat, fullDiff);
  assert.equal(templateBases.at(-1), 'main');
});

test('attachment at unchanged HEAD refuses the old publication base at approval and publication', async () => {
  resetRun();
  const prepared = (
    await prepareCompletionPackage(run.id, {
      diffStat: fullDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  const retained = structuredClone(prepared);
  run = { ...run, stack };
  githubRequests = 0;
  await assert.rejects(
    assertReadyGatePackageInputsCurrent(run, prepared),
    /publication base.*refresh/i,
  );
  await assert.rejects(publishCompletionPackage(run.id, prepared), /publication base.*refresh/i);
  assert.equal(githubRequests, 0);
  assert.deepEqual(prepared, retained);
  const refreshed = (
    await prepareCompletionPackage(run.id, {
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(refreshed.headSha, prepared.headSha);
  assert.equal(refreshed.reviewSnapshot?.baseRef, 'origin/feature/parent');
  await assertReadyGatePackageInputsCurrent(run, refreshed);
});

test('an unavailable diff still captures the publication base without granting diff proof', async () => {
  resetRun(stack);
  run = { ...run, slotId: null };
  const prepared = (
    await prepareCompletionPackage(run.id, {
      headSha,
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(prepared.reviewSnapshot?.source, 'unavailable');
  assert.equal(prepared.reviewSnapshot?.baseRef, 'origin/feature/parent');
  assert.equal(prepared.reviewSnapshot?.diffHash, undefined);
  await assertReadyGatePackageInputsCurrent(run, prepared);
});

test('a follow-up package and preview use the stacked parent contribution', async () => {
  resetRun();
  lineageParent = { ...run, id: 'stacked-parent', stack };
  run = { ...run, flowType: 'pr-complete', parentRunId: lineageParent.id };
  const prepared = (
    await prepareCompletionPackage(run.id, {
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(prepared.reviewSnapshot?.baseRef, 'origin/feature/parent');
  assert.equal(prepared.reviewSnapshot?.baseSha, parentSha);
  assert.deepEqual(prepared.reviewSnapshot?.diffStat, parentDiff);
  await renderCurrentDescription(run, prepared);
  assert.equal(templateBases.at(-1), 'feature/parent');
});

test('a comparison child cold review satisfies the one-review publication policy', async () => {
  resetRun();
  lineageParent = { ...run, id: 'stacked-comparison-parent', stack };
  run = { ...run, parentRunId: lineageParent.id };
  const prepared = (
    await prepareCompletionPackage(run.id, {
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
    })
  ).prPackage;
  const { snapshot } = await captureCurrentReviewSnapshot(vars(), {
    mode: 'cold',
    baseRef: await stackPrBase(run),
  });
  const review: ReviewStatus = {
    id: 'comparison-cold-review',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewerSessionId: 'comparison-review-session',
    reviewedHeadSha: prepared.headSha,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: snapshot,
  };
  run = {
    ...run,
    engineState: {
      ...run.engineState,
      publishGate: { ...run.engineState?.publishGate, reviews: [review] },
    },
  };
  assert.equal(snapshot.baseRef, prepared.reviewSnapshot?.baseRef);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, prepared));
  run.engineState!.publishGate!.reviews = [
    { ...review, reviewSnapshot: { ...snapshot, baseRef: 'origin/main' } },
  ];
  assert.throws(
    () => assertPublicationReviewPolicySatisfied(run, prepared),
    /requires passing reviews for the approved package/,
  );
});

test('a retargeted stack uses the default branch after its parent merges', async () => {
  // The existing graph retarget record supplies the default after parent merge.
  git('push', '-q', 'origin', 'feature/parent:main');
  resetRun({ ...stack, retargetedTo: 'main', upstreamMergeSha: parentSha });
  const retargeted = (
    await prepareCompletionPackage(run.id, {
      diffStat: parentDiff,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    })
  ).prPackage;
  assert.equal(retargeted.reviewSnapshot?.baseRef, 'origin/main');
  assert.equal(retargeted.reviewSnapshot?.baseSha, parentSha);
  assert.deepEqual(retargeted.reviewSnapshot?.diffStat, parentDiff);
  assert.equal(templateBases.at(-1), 'main');
});

test('package preparation stamps visual judgments on the selected proof, not on selected baseline captures', async (t) => {
  // TAT-4145 bda11b1a: the package selected two baseline captures as before evidence. Stamping read
  // only that attempt, so the gate review's confirmed judgments on proof-7ff8b575-1 never applied.
  resetRun();
  const publication: RecordedEvidenceSource[] = [];
  const selected: RecordedEvidenceSource[] = [];
  scriptedEvidence = { publication, selected, publicationKeys: [] };
  stampedSources.length = 0;
  t.after(() => {
    scriptedEvidence = null;
  });
  run.agentContexts = [
    {
      id: 'rev-codex-native-112376dbd2de-de3ee3fa',
      role: 'review',
      label: 'rev-codex (gpt-6.1-sol)',
      status: 'complete',
      runId: run.id,
      slotId: run.slotId,
      runner: 'codex',
      reviewResultValidatedAt: '2026-10-20T04:04:57.791Z',
      pipelineVisualReviewResult: {
        headSha,
        binding: {
          contextId: 'rev-codex-native-112376dbd2de-de3ee3fa',
          executionNodeId: 'macpro',
          ownerPrincipalId: 'farm-automation',
          sessionId: 'session-112376dbd2de',
          generation: 'generation-1',
          leaseId: 'lease-1',
          commandId: 'command-1',
        },
        result: {
          schemaVersion: 1,
          recipeRunId: 'a4308cd5-0731-4a89-9198-3a1f180f7181',
          closureIdentity: 'sha256:2ffa57a61',
          judgments: [],
        },
        completedAt: '2026-10-20T04:04:57.791Z',
      },
    },
  ];

  const { prPackage } = await prepareCompletionPackage(run.id, {
    diffStat: fullDiff,
    reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
  });

  assert.equal(stampedSources.length, 1);
  assert.equal(stampedSources[0], publication, 'stamped against the gate publication sources');
  assert.notEqual(stampedSources[0], selected);
  assert.deepEqual(scriptedEvidence.publicationKeys, [prPackage.selectedEvidenceKeys]);
});
