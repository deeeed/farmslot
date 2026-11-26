import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import {
  materializeReviewWorkspaceTask,
  readReviewWorkspaceCompletion,
  readReviewWorkspaceProgress,
  readReviewWorkspaceSignal,
} from './task.js';
import { checklist, withReviewWorkspaceTaskFixture } from './task-fixture.test-support.js';
import { type executeWorkspaceReviewTaskStart, REVIEW_WORKSPACE_SCRIPT } from './workspace.js';

type Fixture = Parameters<Parameters<typeof withReviewWorkspaceTaskFixture>[0]>[0];

const SKILL = 'mms-perps-review-pr';
const ROUND_CHECKLIST =
  '# Static review\n\n## Setup\n\n- [ ] 1. Read the diff\n\n## Verdict\n\n- [ ] 2. Write the verdict\n';

// The skill's `start`, reduced to the round folder its contract describes (ADR-058 Amendment 4).
const START = `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('../start-calls.log', JSON.stringify(args) + '\\n');
const [base, head] = args[1].split('..');
const dir = 'temp/tasks/review/pr-' + args[3] + '/r1';
if (!fs.existsSync(dir + '/review.json')) {
  fs.mkdirSync(dir + '/artifacts', { recursive: true });
  fs.writeFileSync(dir + '/CHECKLIST.md', ${JSON.stringify(ROUND_CHECKLIST)});
  fs.writeFileSync(dir + '/SIGNAL.json', JSON.stringify({ attemptId: 'skill-attempt', step: 'started', status: 'running', timestamp: new Date().toISOString() }));
  fs.writeFileSync(dir + '/review.json', JSON.stringify({ schemaVersion: 1, skill: 'perps-review-pr', revision: 'rev-1', target: args[1], pr: args[3], head, forkPoint: base, round: 1, mode: 'cold', reason: 'first round', previous: null, startedAt: new Date().toISOString(), files: ['src/a.ts'], marks: !fs.existsSync('../harness-unavailable'), checklist: 'CHECKLIST.md', rows: 2 }));
}
console.log('Started cold round r1: first round\\nfolder: ' + dir);
`;

/** A perps-domain review of a project whose support installs the review skill. */
async function skillReview(f: Fixture) {
  const workspace = f.run.reviewWorkspace!;
  const root = path.join(f.root, 'workspaces');
  const workspaceDir = path.join(root, 'runs', workspace.workspaceId);
  const checkout = path.join(workspaceDir, 'source');
  workspace.checkoutPath = checkout;
  const scripts = path.join(checkout, '.agents/skills', SKILL, 'scripts');
  await mkdir(scripts, { recursive: true });
  await writeFile(path.join(scripts, 'review-task.mjs'), START);
  await mkdir(path.join(workspaceDir, 'review-tasks'));
  await mkdir(path.join(checkout, 'temp'));
  await symlink('../../review-tasks', path.join(checkout, 'temp/tasks'));
  const identity = {
    runId: f.run.id,
    workspaceId: workspace.workspaceId,
    owner: f.run.nativeOwnerPrincipalId,
    project: f.run.project,
    machine: workspace.machine,
    executionNodeId: workspace.executionNodeId,
    repositoryUrl: f.subject.repositoryUrl,
    headSha: f.subject.headSha,
    baseSha: f.subject.baseSha,
  };
  await writeFile(path.join(workspaceDir, 'identity.json'), JSON.stringify(identity));
  await writeFile(path.join(workspaceDir, 'allocation.json'), JSON.stringify({ state: 'ready' }));
  const cacheIdentity = JSON.stringify({
    owner: identity.owner,
    project: identity.project,
    repositoryUrl: identity.repositoryUrl,
  });
  const cacheKey = createHash('sha256').update(cacheIdentity).digest('hex');
  await mkdir(path.join(root, 'repositories'));
  await writeFile(path.join(root, 'repositories', cacheKey + '.json'), cacheIdentity);
  f.run.domain = 'perps';
  f.run.reviewContext = { freshChain: true, reviewLineages: [null] };
  f.run.reviewWorkspace!.support = {
    path: path.join(f.root, 'support'),
    sha256: 'f'.repeat(64),
    sources: [],
    skills: [
      {
        name: SKILL,
        path: path.join(f.root, 'support/skill-sources', SKILL, 'skill.md'),
        install: {
          repo: 'core',
          source: path.join(f.root, 'support/skill-sources', SKILL),
          include: 'perps/perps-review-pr',
          installedName: SKILL,
        },
      },
    ],
    environment: {},
  };
  let generation = 0;
  const deps = {
    ...f.deps,
    readCommentDiff: async () => '@@ -2,1 +2,2 @@\n unchanged\n+added\n',
    startSkillTask: (async (_run, _subject, start, assertCurrent) => {
      await assertCurrent();
      const argv = [
        '-e',
        REVIEW_WORKSPACE_SCRIPT,
        JSON.stringify({
          root,
          identity,
          generation,
          action: 'start-review-task',
          taskPath: f.task,
          reviewTaskStart: start,
        }),
      ];
      const result = spawnSync(process.execPath, argv, { encoding: 'utf8' });
      if (result.error) throw result.error;
      const output = JSON.parse(result.stdout);
      if (result.status !== 0) throw Error(output.error?.message || result.stderr);
      assert.equal(output.state, 'review-task');
      await assertCurrent();
      return { stdout: String(output.stdout), stderr: String(output.stderr) };
    }) satisfies typeof executeWorkspaceReviewTaskStart,
    recordReviewTask: async (
      _runId: string,
      round: NonNullable<NonNullable<Fixture['run']['reviewWorkspace']>['reviewTask']>,
    ) => {
      f.run.reviewWorkspace!.reviewTask = round;
    },
  };
  const folder = path.join(workspaceDir, 'review-tasks/review/pr-1/r1');
  const callsFile = path.join(workspaceDir, 'start-calls.log');
  const calls = async () =>
    (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  return {
    deps,
    folder,
    calls,
    callsFile,
    workspaceDir,
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}

/** The reviewer was accepted now; marks before this belong to the gateway's start. */
function accept(f: Fixture): string {
  const acceptedAt = new Date().toISOString();
  const context: AgentContext = {
    id: 'review',
    role: 'review',
    label: 'Review',
    slotId: null,
    runId: f.run.id,
    status: 'working',
    nativeSession: {
      sessionId: 'session',
      leaseId: 'lease',
      commandId: 'command',
      ownerPrincipalId: 'fixture-owner',
      executionNodeId: 'local',
      generation: 'generation',
      acceptedAt,
      launchRequestedAt: acceptedAt,
    },
  };
  f.run.agentContexts = [context];
  return acceptedAt;
}

/** What `finish` leaves: artifacts, a ticked checklist, the terminal mark, the verdict. */
async function finishRound(
  folder: string,
  acceptedAt: string,
  options: { verdict: string; commit: string; finished?: boolean },
) {
  const at = new Date(Date.parse(acceptedAt) + 1000).toISOString();
  await writeFile(
    path.join(folder, 'artifacts/review.md'),
    `# Review\n\nVERDICT: ${options.verdict}\nCOMMIT: ${options.commit}\n`,
  );
  await writeFile(
    path.join(folder, 'artifacts/review-ledger.md'),
    '# Review ledger\n\n## 1. Read the diff\n\nOutcome: PASS read every file.\n\n## 2. Write the verdict\n\nOutcome: FINDING the order guard is missing.\n',
  );
  await writeFile(
    path.join(folder, 'artifacts/line-comments.json'),
    JSON.stringify({
      comments:
        options.verdict === 'REQUEST_CHANGES'
          ? [{ path: 'src/a.ts', line: 3, body: 'Guard the order.', severity: 'must_fix' }]
          : [],
    }),
  );
  await writeFile(path.join(folder, 'artifacts/learnings.md'), '- Check order guards.\n');
  await writeFile(path.join(folder, 'CHECKLIST.md'), ROUND_CHECKLIST.replaceAll('[ ]', '[x]'));
  await writeFile(
    path.join(folder, 'SIGNAL.json'),
    JSON.stringify({
      attemptId: 'skill-attempt',
      step: 'complete',
      status: 'complete',
      outcome: 'success',
      disposition: 'fixed',
      timestamp: at,
      checklistTiming: { schemaVersion: 1, source: 'CHECKLIST.md', events: [] },
    }),
  );
  if (options.finished === false) return;
  const record = JSON.parse(await readFile(path.join(folder, 'review.json'), 'utf8'));
  await writeFile(
    path.join(folder, 'review.json'),
    JSON.stringify({ ...record, verdict: options.verdict, finishedAt: at }),
  );
}

test('a skill review starts its round in the checkout and gives the reviewer one step', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, folder, calls } = await skillReview(f);
    // A project review in the skill's domain needs no frozen static template.
    f.run.executionTemplate = undefined;
    f.subject.contributionBaseSha = 'd'.repeat(40);
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, f.subject, {
        ...deps,
        recordReviewTask: async () => {
          throw new Error('Stopped before recording the round');
        },
      }),
      /Stopped before recording the round/,
    );
    const task = await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    assert.deepEqual(await calls(), [
      ['start', `${f.subject.contributionBaseSha}..${f.subject.headSha}`, '--pr', '1', '--cold'],
      ['start', `${f.subject.contributionBaseSha}..${f.subject.headSha}`, '--pr', '1'],
    ]);
    assert.deepEqual(f.run.reviewWorkspace!.reviewTask, {
      folder,
      round: 1,
      mode: 'cold',
      headSha: f.subject.headSha,
      revision: 'rev-1',
      startedAt: f.run.reviewWorkspace!.reviewTask!.startedAt,
      attemptId: 'skill-attempt',
    });
    const text = await readFile(task.taskFile, 'utf8');
    for (const document of [text, task.prompt]) {
      assert(document.includes(`Run the ${SKILL} review skill in '${folder}'`));
      assert(document.includes(`'${path.join(folder, 'mark')}' <n>`));
      assert(document.includes(`finish '${folder}'`));
      assert.doesNotMatch(document, /review-result\.json|coverage|warm-delta|approval/i);
    }
    // The round's CHECKLIST.md is the only checklist; no Farmslot warm or prior inputs.
    for (const file of ['CHECKLIST.md', 'inputs/prior-review.json', 'inputs/warm-delta.json'])
      await assert.rejects(readFile(path.join(f.task, file)), { code: 'ENOENT' });
    assert.match(await readFile(path.join(f.task, 'inputs/review-subject.json'), 'utf8'), /aaaa/);

    // A retry before launch resumes the same round, without asking for another cold one.
    await rm(path.join(f.root, 'gateway-snapshots', f.run.id, 'snapshot.json'));
    const recorded = structuredClone(f.run.reviewWorkspace!.reviewTask);
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    assert.equal((await calls()).length, 2);
    assert.deepEqual(f.run.reviewWorkspace!.reviewTask, recorded);
  });
});

test('a review outside the skill domain keeps the static template path', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, callsFile } = await skillReview(f);
    f.run.domain = 'swaps';
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    assert.equal(f.run.reviewWorkspace!.reviewTask, undefined);
    assert.equal(await readFile(path.join(f.task, 'CHECKLIST.md'), 'utf8'), checklist);
    await assert.rejects(readFile(callsFile), { code: 'ENOENT' });
    f.run.executionTemplate = undefined;
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, f.subject, deps),
      /frozen template and source subject/,
    );
  });
});

test('an unmarked fallback can replay after the harness returns', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, folder, workspaceDir } = await skillReview(f);
    const unavailable = path.join(workspaceDir, 'harness-unavailable');
    await writeFile(unavailable, '');
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, f.subject, deps),
      /has no marked checklist/,
    );
    await assert.rejects(readFile(path.join(folder, 'review.json')), { code: 'ENOENT' });
    await rm(unavailable);
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    assert.equal(f.run.reviewWorkspace!.reviewTask?.folder, folder);
  });
});

test('a replay generation replaces an unpublished round and fences the older start', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, folder, setGeneration } = await skillReview(f);
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, f.subject, {
        ...deps,
        recordReviewTask: async () => {
          throw Error('Stopped before binding');
        },
      }),
      /Stopped before binding/,
    );
    const oldRecord = await readFile(path.join(folder, 'review.json'), 'utf8');
    setGeneration(1);
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    const currentRecord = await readFile(path.join(folder, 'review.json'), 'utf8');
    assert.notEqual(currentRecord, oldRecord);
    await rm(path.join(f.root, 'gateway-snapshots', f.run.id, 'snapshot.json'));
    setGeneration(0);
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, f.subject, deps),
      /generation was superseded/,
    );
    assert.equal(await readFile(path.join(folder, 'review.json'), 'utf8'), currentRecord);
  });
});

for (const verdict of ['APPROVE', 'REQUEST_CHANGES']) {
  test(`a finished skill round maps to the review result (${verdict})`, async () => {
    await withReviewWorkspaceTaskFixture(async (f) => {
      const { deps, folder } = await skillReview(f);
      await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
      const acceptedAt = accept(f);
      // The gateway's own start mark is no startup evidence.
      assert.equal(await readReviewWorkspaceSignal(f.run.id, deps), null);
      await finishRound(folder, acceptedAt, {
        verdict,
        commit: f.subject.headSha,
        finished: false,
      });
      // Terminal mark written, verdict not yet: finish is still running.
      assert.equal(await readReviewWorkspaceCompletion(f.run.id, deps), null);
      await finishRound(folder, acceptedAt, { verdict, commit: f.subject.headSha });
      const completion = await readReviewWorkspaceCompletion(f.run.id, deps);
      assert(completion?.result);
      const { result } = completion;
      assert.equal(result.recommendation, verdict);
      assert.match(result.reviewMd, new RegExp(`VERDICT: ${verdict}`));
      assert.deepEqual(
        result.lineComments,
        verdict === 'APPROVE'
          ? []
          : [{ path: 'src/a.ts', line: 3, body: 'Guard the order.', severity: 'must_fix' }],
      );
      assert.deepEqual(result.reviewTask, { round: 1, mode: 'cold' });
      assert.equal(result.reviewSnapshot?.headSha, f.subject.headSha);
      // The round survives cleanup in the retained view, learnings where they go today.
      const view = path.join(f.root, 'gateway-snapshots', f.run.id, 'view');
      for (const file of [
        'artifacts/review-ledger.md',
        'artifacts/learnings.md',
        'CHECKLIST.md',
        'SIGNAL.json',
        'review.json',
      ])
        assert((await readFile(path.join(view, file), 'utf8')).length > 0);
      assert(result.artifactManifest?.some((entry) => entry.path.endsWith('review-ledger.md')));
    });
  });
}

test('a skill round is refused for another commit, head or skill revision', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, folder } = await skillReview(f);
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    const acceptedAt = accept(f);
    await finishRound(folder, acceptedAt, { verdict: 'APPROVE', commit: 'c'.repeat(40) });
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, deps), {
      code: 'REVIEW_OUTPUT_INVALID',
    });
    await finishRound(folder, acceptedAt, { verdict: 'APPROVE', commit: f.subject.headSha });
    const record = JSON.parse(await readFile(path.join(folder, 'review.json'), 'utf8'));
    for (const patch of [{ head: 'c'.repeat(40) }, { revision: 'rev-2' }]) {
      await writeFile(path.join(folder, 'review.json'), JSON.stringify({ ...record, ...patch }));
      await assert.rejects(
        readReviewWorkspaceCompletion(f.run.id, deps),
        /recorded head, revision and round/,
      );
    }
    const signalFile = path.join(folder, 'SIGNAL.json');
    const signal = JSON.parse(await readFile(signalFile, 'utf8'));
    await writeFile(signalFile, JSON.stringify({ ...signal, attemptId: 'unrelated-attempt' }));
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, deps),
      /does not belong to the recorded round attempt/,
    );
    await writeFile(path.join(folder, 'review.json'), JSON.stringify(record));
    await finishRound(folder, acceptedAt, {
      verdict: 'REQUEST_CHANGES',
      commit: f.subject.headSha,
    });
    await writeFile(
      path.join(folder, 'artifacts/line-comments.json'),
      JSON.stringify({
        comments: [{ path: 'src/a.ts', line: 9, body: 'Outside', severity: 'must_fix' }],
      }),
    );
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, deps),
      /outside the RIGHT-side diff/,
    );
  });
});

test('skill review progress reads the round checklist', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const { deps, folder } = await skillReview(f);
    await materializeReviewWorkspaceTask(f.run.id, f.subject, deps);
    const progress = await readReviewWorkspaceProgress(f.run.id, deps);
    assert.equal(progress.taskDir, folder);
    assert.equal(progress.checklistPath, path.join(folder, 'CHECKLIST.md'));
    assert.equal(progress.markdown, ROUND_CHECKLIST);
  });
});
