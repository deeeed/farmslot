import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  reviewDiffHash,
  type ReviewDiffSnapshot,
  reviewSnapshotIdentityText,
  type ReviewStatus,
  type Run,
  type RunAdoptPublishedPrParams,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');
const { runAdoptPublishedPr } = await import('./adopt-published-pr.js');
const { differingPatchFiles } = await import('./publication-content-match.js');
const { createRun, getRun, updateRun } = await import('../../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } =
  await import('../../run-engine/test-fixtures.js');
const { buildCIWatchChainedRunParams } = await import('../../run-engine/ci-watch-chain.js');
type Dependencies = import('./adopt-published-pr.js').PublicationAdoptionDependencies;

const reviewedHead = 'a'.repeat(40);
const prHead = 'b'.repeat(40);
const prBase = 'e'.repeat(40);
const approver = {
  principalId: 'human',
  credentialId: 'human-credential',
  displayName: 'Operator',
};
const noop = () => {};

const reviewedDiff = [
  'diff --git a/src/order.ts b/src/order.ts',
  'index 1111111..2222222 100644',
  '--- a/src/order.ts',
  '+++ b/src/order.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const sheet = old();',
  '+const sheet = configured();',
  ' export { a };',
  'diff --git a/CHANGELOG.md b/CHANGELOG.md',
  'index 3333333..4444444 100644',
  '--- a/CHANGELOG.md',
  '+++ b/CHANGELOG.md',
  '@@ -1,2 +1,3 @@',
  ' # Changelog',
  '+- Configure the order sheet before opening it.',
  ' ## 0.96.0',
  '',
].join('\n');

/** The same change after main was merged in: other line numbers and blob ids, same content. */
const republishedDiff = reviewedDiff
  .replace('index 1111111..2222222 100644', 'index 5555555..6666666 100644')
  .replace('@@ -1,3 +1,3 @@', '@@ -40,3 +40,3 @@')
  .replace('index 3333333..4444444 100644', 'index 7777777..8888888 100644')
  .replace('@@ -1,2 +1,3 @@', '@@ -1,4 +1,5 @@');

/** The CHANGELOG conflict resolved by hand: a different hunk in one file. */
const resolvedDiff = republishedDiff.replace(
  '+- Configure the order sheet before opening it.',
  '+- Configure the order sheet before opening it (#541).',
);

interface Fixture {
  run: Run;
  taskDir: string;
}

interface FixtureOptions {
  reviewed?: string;
  untracked?: ReviewDiffSnapshot['untrackedFiles'];
  tamper?: boolean;
  /** The gate's reviews, built from a review that certifies the package (default: just that one). */
  reviews?: (certifying: ReviewStatus) => ReviewStatus[];
  minimumReviews?: number;
  /** The gate points at another package than the ready decision's. */
  stalePackage?: boolean;
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}): Promise<Fixture> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), 'adopt-content-'));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  const diff = options.reviewed ?? reviewedDiff;
  const diffPath = 'artifacts/publication-packages/diff-reviewed.diff';
  await mkdir(path.join(taskDir, 'artifacts', 'publication-packages'), { recursive: true });
  await writeFile(path.join(taskDir, diffPath), options.tamper ? `${diff}+tampered\n` : diff);
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'MANUAL-000183',
    branch: 'fix/manual-000183-fix-perps-configure-order-shee',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const snapshot: ReviewDiffSnapshot = {
    source: 'local-git',
    baseRef: 'origin/main',
    baseSha: 'c'.repeat(40),
    headSha: reviewedHead,
    diffHash: reviewDiffHash(reviewSnapshotIdentityText(diff, options.untracked ?? [])),
    diffStat: { files: 2, additions: 2, deletions: 1 },
    ...(options.untracked ? { untrackedFiles: options.untracked } : {}),
    diffPath,
    capturedAt: '2026-11-08T22:37:56.755Z',
  };
  const prepared = makeReadyGatePackage({
    headSha: reviewedHead,
    branch: 'fix/manual-000183-fix-perps-configure-order-shee',
    reviewSnapshot: snapshot,
    reviewPolicy: { minimumReviews: options.minimumReviews ?? 1, requestedBy: 'dispatch' },
  });
  const certifying: ReviewStatus = {
    id: 'review-4',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 4,
    reviewerSessionId: 'session-4',
    reviewedHeadSha: reviewedHead,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: snapshot,
    verdict: 'pass',
    unresolvedCount: 0,
  };
  return {
    taskDir,
    run: updateRun(run.id, {
      status: 'blocked',
      taskFile: path.join(taskDir, 'TASK.md'),
      engineState: {
        generation: 1,
        publishGate: {
          packageId: options.stalePackage ? 'pkg-newer' : prepared.id,
          packageHash: prepared.packageHash,
          publicationStatus: 'not_published',
          reviews: (options.reviews ?? ((review) => [review]))(certifying),
        },
      },
      decisions: [
        {
          id: 'publish-wait',
          type: 'engine_human_gate',
          title: 'Publish',
          description: '',
          createdAt: new Date().toISOString(),
          actions: [{ id: 'approve-publish', label: 'Publish', style: 'primary' }],
          payload: {
            kind: 'ready',
            prPackage: prepared,
            prNumber: null,
            repo: 'owner/repo',
            diffStat: { files: 2, additions: 2, deletions: 1 },
            workerReport: '',
            branch: 'fix/manual-000183-fix-perps-configure-order-shee',
          },
        },
      ],
    }),
  };
}

interface GithubOverrides {
  headRepo?: string;
  prBranch?: string;
  /** Records every compare path read, to prove the comparison is pinned. */
  compares?: string[];
}

function dependencies(
  published: string,
  overrides: Partial<Dependencies> & GithubOverrides = {},
): Dependencies {
  const {
    headRepo = 'owner/repo',
    prBranch = 'fix/mobile-perps-configure-order-sheet',
    compares,
    ...rest
  } = overrides;
  return {
    authorizeEvidenceAttestation: () => approver,
    repository: async () => 'owner/repo',
    discover: async () => null,
    github: async (args) => {
      if (args.some((arg) => arg.endsWith('/commits')))
        return { stdout: `${reviewedHead}\n${prHead}\n`, stderr: '' };
      if (args.includes('Accept: application/vnd.github.diff')) {
        const target = args.find((arg) => arg.includes('/compare/'));
        if (!target) throw new Error('the PR diff must be read for a pinned range');
        compares?.push(target);
        return { stdout: published, stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          number: 541,
          html_url: 'https://github.com/owner/repo/pull/541',
          state: 'closed',
          merged_at: '2026-11-09T00:10:00Z',
          draft: false,
          base: { sha: prBase, repo: { full_name: 'owner/repo' } },
          head: { sha: prHead, ref: prBranch, repo: { full_name: headRepo } },
        }),
        stderr: '',
      };
    },
    readiness: async (run) => ({
      state: 'ready',
      identity: { runId: run.id, generation: 1 },
      reasons: [],
    }),
    continuationRefusals: async () => [
      { code: 'run-work-progressing', prerequisite: 'lifecycle', message: 'Held for the test' },
    ],
    ...rest,
  };
}

const contentRequest = (run: Run): RunAdoptPublishedPrParams => ({
  runId: run.id,
  prRef: 'https://github.com/owner/repo/pull/541',
});

const attestedRequest = (run: Run): RunAdoptPublishedPrParams => ({
  runId: run.id,
  prRef: 'https://github.com/owner/repo/pull/541',
  headSha: reviewedHead,
  reason: 'Owner republished the reviewed commit; CHANGELOG conflict resolved by hand.',
  attestReviewedPublication: true,
});

test('a same-repository PR on another branch is adopted when its change matches the reviewed patch', async (t) => {
  const { run } = await fixture(t);
  const result = await runAdoptPublishedPr(
    contentRequest(run),
    noop,
    dependencies(republishedDiff),
  );
  assert.equal(result.receipt.match?.type, 'content-match');
  assert.equal(result.receipt.match?.runBranch, 'fix/manual-000183-fix-perps-configure-order-shee');
  assert.equal(result.receipt.match?.prBranch, 'fix/mobile-perps-configure-order-sheet');
  assert.deepEqual(result.receipt.match?.differingFiles, []);
  assert.deepEqual(result.receipt.match?.compared, { baseSha: prBase, headSha: prHead });
  assert.equal(result.receipt.headSha, prHead, 'content match adopts the observed PR head');
  assert.equal(result.receipt.observedBranch, 'fix/mobile-perps-configure-order-sheet');
  assert.match(result.receipt.reason, /content matches the reviewed patch/);
  const gate = getRun(run.id)!.decisions.find((decision) => decision.id === 'publish-wait')!;
  assert.deepEqual(gate.publicationAdoption, {
    receiptId: result.receipt.id,
    match: result.receipt.match,
    reason: result.receipt.reason,
  });
});

test('a content mismatch refuses, names the differing files and the attested command, and writes nothing', async (t) => {
  const { run } = await fixture(t);
  const before = structuredClone(getRun(run.id));
  await assert.rejects(
    runAdoptPublishedPr(contentRequest(run), noop, dependencies(resolvedDiff)),
    (error: Error) => {
      assert.match(error.message, /does not match the reviewed patch/);
      assert.match(error.message, /CHANGELOG\.md/);
      assert.doesNotMatch(error.message, /src\/order\.ts/);
      assert.match(error.message, /fix\/mobile-perps-configure-order-sheet/);
      assert.match(
        error.message,
        new RegExp(
          `farmslot run adopt-published-pr ${run.id} --pr https://github.com/owner/repo/pull/541 --head ${prHead} --attest-reviewed-publication --reason`,
        ),
      );
      return true;
    },
  );
  assert.deepEqual(getRun(run.id), before);
});

test('the attested head is the human override for a mismatch and records it as attested', async (t) => {
  const { run } = await fixture(t);
  const result = await runAdoptPublishedPr(attestedRequest(run), noop, dependencies(resolvedDiff));
  assert.equal(result.receipt.match?.type, 'attested');
  assert.deepEqual(result.receipt.match?.differingFiles, ['CHANGELOG.md']);
  assert.equal(result.receipt.match?.prBranch, 'fix/mobile-perps-configure-order-sheet');
  assert.equal(result.receipt.headSha, reviewedHead);
  assert.match(result.receipt.reason, /CHANGELOG conflict resolved by hand/);
  const gate = getRun(run.id)!.decisions.find((decision) => decision.id === 'publish-wait')!;
  assert.equal(gate.publicationAdoption?.match.type, 'attested');
});

test('an attested head whose content also matches is recorded as a content match', async (t) => {
  const { run } = await fixture(t);
  const result = await runAdoptPublishedPr(
    attestedRequest(run),
    noop,
    dependencies(republishedDiff),
  );
  assert.equal(result.receipt.match?.type, 'content-match');
  assert.match(result.receipt.reason, /CHANGELOG conflict resolved by hand/);
});

test('never across repositories: a fork head refuses even with a matching patch or an attestation', async (t) => {
  const { run } = await fixture(t);
  const before = structuredClone(getRun(run.id));
  for (const request of [contentRequest(run), attestedRequest(run)])
    await assert.rejects(
      runAdoptPublishedPr(request, noop, dependencies(republishedDiff, { headRepo: 'fork/repo' })),
      /retained repository/,
    );
  assert.deepEqual(getRun(run.id), before);
});

test('a reviewed diff that no longer verifies, or untracked reviewed files, cannot prove a content match', async (t) => {
  const tampered = await fixture(t, { tamper: true });
  await assert.rejects(
    runAdoptPublishedPr(contentRequest(tampered.run), noop, dependencies(republishedDiff)),
    /reviewed patch could not be verified/,
  );
  const untracked = await fixture(t, {
    untracked: [{ path: 'notes/local.md', blobSha: 'd'.repeat(40), mode: '100644' as const }],
  });
  await assert.rejects(
    runAdoptPublishedPr(contentRequest(untracked.run), noop, dependencies(republishedDiff)),
    /notes\/local\.md/,
  );
});

test('a head without the attestation is refused; content mode adopts the observed head only', async (t) => {
  const { run } = await fixture(t);
  const invalid = { ...contentRequest(run), headSha: prHead };
  await assert.rejects(
    // @ts-expect-error A head belongs to the attested request only; the gateway refuses it at runtime too.
    runAdoptPublishedPr(invalid, noop, dependencies(republishedDiff)),
    /--head is only accepted with --attest-reviewed-publication/,
  );
});

test('the comparison reads the PR range pinned to the SHAs read with the facts', async (t) => {
  const { run } = await fixture(t);
  const compares: string[] = [];
  await runAdoptPublishedPr(contentRequest(run), noop, dependencies(republishedDiff, { compares }));
  assert.deepEqual(compares, [`repos/owner/repo/compare/${prBase}...${prHead}`]);
});

test("only a patch the gate's review policy certifies, on the gate package, can prove a content match", async (t) => {
  const refused = /the gate's review policy does not certify the recorded patch/;
  const cases: Array<[string, FixtureOptions, RegExp]> = [
    ['no review', { reviews: () => [] }, refused],
    [
      'a pass on another patch',
      {
        reviews: (review) => [
          { ...review, reviewSnapshot: { ...review.reviewSnapshot!, diffHash: 'f'.repeat(64) } },
        ],
      },
      refused,
    ],
    [
      'a second reviewer with open findings on the same patch',
      {
        reviews: (review) => [
          review,
          {
            ...review,
            id: 'review-5',
            reviewerSessionId: 'session-5',
            verdict: 'issues',
            unresolvedCount: 1,
          },
        ],
      },
      refused,
    ],
    [
      'a pass that still has unresolved findings',
      { reviews: (review) => [{ ...review, unresolvedCount: 2 }] },
      refused,
    ],
    [
      'a pass without a reviewer session',
      { reviews: (review) => [{ ...review, reviewerSessionId: null }] },
      refused,
    ],
    ['one pass where the policy needs two', { minimumReviews: 2 }, refused],
    ['a newer package on the gate', { stalePackage: true }, /not the gate's current package/],
  ];
  for (const [label, options, reason] of cases) {
    const { run } = await fixture(t, options);
    const before = structuredClone(getRun(run.id));
    await assert.rejects(
      runAdoptPublishedPr(contentRequest(run), noop, dependencies(republishedDiff)),
      reason,
      label,
    );
    assert.deepEqual(getRun(run.id), before, label);
  }
});

test('chained CI work follows the adopted PR branch and prepares it instead of reusing the slot checkout', async (t) => {
  const { run } = await fixture(t);
  updateRun(run.id, { slotId: 'slot-1' });
  const result = await runAdoptPublishedPr(
    contentRequest(run),
    noop,
    dependencies(republishedDiff),
  );
  const chain = buildCIWatchChainedRunParams(result.run, 'dispatch-pr-complete', 'owner/repo');
  assert.equal(chain?.createParams.branch, 'fix/mobile-perps-configure-order-sheet');
  assert.equal(chain?.createParams.ticketOrPr, 'owner/repo#541');
  assert.deepEqual(
    chain?.engineFlags,
    {},
    'the retained checkout is on the run branch, not the PR',
  );
  const sameBranch = buildCIWatchChainedRunParams(
    { ...result.run, branch: 'fix/mobile-perps-configure-order-sheet' },
    'dispatch-pr-complete',
    'owner/repo',
  );
  assert.deepEqual(sameBranch?.engineFlags, { skipPrepare: true, warmSessionReuse: true });
});

test('whitespace and file modes are part of the change', () => {
  const reindented = reviewedDiff.replace(
    '+const sheet = configured();',
    '+const sheet =  configured();',
  );
  assert.deepEqual(differingPatchFiles(reviewedDiff, reindented), ['src/order.ts']);
  const spaced = reviewedDiff.replace(
    '+- Configure the order sheet',
    '+-  Configure the order sheet',
  );
  assert.deepEqual(differingPatchFiles(reviewedDiff, spaced), ['CHANGELOG.md']);
  const executable = reviewedDiff.replace(
    'index 1111111..2222222 100644',
    'old mode 100644\nnew mode 100755\nindex 1111111..2222222',
  );
  assert.deepEqual(differingPatchFiles(reviewedDiff, executable), ['src/order.ts']);
});

test('per-file comparison ignores line offsets and blob ids, and reports renames, deletions and binaries', () => {
  assert.deepEqual(differingPatchFiles(reviewedDiff, republishedDiff), []);
  assert.deepEqual(differingPatchFiles(reviewedDiff, resolvedDiff), ['CHANGELOG.md']);
  const onlyOrder = reviewedDiff.slice(0, reviewedDiff.indexOf('diff --git a/CHANGELOG.md'));
  assert.deepEqual(differingPatchFiles(reviewedDiff, onlyOrder), ['CHANGELOG.md']);
  const binary = (blob: string) =>
    [
      'diff --git a/logo.png b/logo.png',
      `index 0000000..${blob}`,
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
  assert.deepEqual(differingPatchFiles(binary('1234567'), binary('1234567')), []);
  assert.deepEqual(differingPatchFiles(binary('1234567'), binary('7654321')), ['logo.png']);
  const rename = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    '',
  ].join('\n');
  assert.deepEqual(differingPatchFiles(rename, rename), []);
  assert.deepEqual(differingPatchFiles(rename, ''), ['old.ts -> new.ts']);
});
