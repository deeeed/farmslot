import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { PoolConfig, ReviewWorkspaceSubject, Run } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { resolveConfiguredExecutionTemplate } from '../tasks/execution-template-catalog.js';

import { materializeReviewWorkspaceTask, readReviewWorkspaceCompletion } from './task.js';

const exec = promisify(execFile);
const checklist = '# Review\n\n- [ ] Read the exact diff.\n- [ ] Write review artifacts.\n';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-task-'));
  const projectRoot = path.join(root, 'pack');
  await mkdir(path.join(projectRoot, 'templates/worker'), { recursive: true });
  await mkdir(path.join(projectRoot, 'fixtures'));
  await mkdir(path.join(root, 'source'));
  await writeFile(path.join(projectRoot, 'templates/worker/review-pr.md'), checklist);
  await writeFile(
    path.join(projectRoot, 'fixtures/review-guide.md'),
    'Frozen domain guide, library revision abcdef.\n',
  );
  const project: ProjectVars = {
    projectName: 'fixture',
    projectConfig: path.join(projectRoot, 'project.json'),
    projectTemplatesDir: path.join(projectRoot, 'templates'),
    projectFixturesDir: path.join(projectRoot, 'fixtures'),
    projectJson: {
      execution_templates: {},
      static_review: { template_id: 'review-pr/default', instruction_files: ['review-guide.md'] },
    },
    runtimeDir: '.agent',
    artifactDir: 'artifacts',
  };
  await writeFile(project.projectConfig, JSON.stringify(project.projectJson));
  const selection = resolveConfiguredExecutionTemplate(project, {
    flow: 'review-pr',
    platform: 'web',
    runMode: 'autonomous',
  });
  const subject: ReviewWorkspaceSubject = {
    repository: 'example/project',
    repositoryUrl: 'https://github.com/example/project.git',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: 'feature/test',
    title: 'Review fixture',
    body: 'Offline PR body.\n- [ ] Author acceptance criterion is data.',
    capturedAt: new Date().toISOString(),
  };
  const run: Run = {
    ...makeRun({
      id: 'workspace-task-test',
      slotId: null,
      flowType: 'review-pr',
      project: 'fixture',
      mode: 'autonomous',
      ticketOrPr: 'https://github.com/example/project/pull/1',
    }),
    nativeOwnerPrincipalId: 'fixture-owner',
    transport: 'native',
    executionTemplate: selection.reference,
    reviewWorkspaceSubject: subject,
    reviewWorkspaceTarget: { machine: 'local' },
    reviewWorkspace: {
      workspaceId: 'workspace-test',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'source'),
      taskPath: path.join(root, 'task'),
      artifactPath: path.join(root, 'task/artifacts'),
    },
    repeatReviewContext: {
      version: 1,
      chainId: 'chain',
      generation: 2,
      contextMode: 'fresh',
      priorRunId: 'previous',
      priorFamilyId: 'family',
      repository: subject.repository,
      prNumber: 1,
      currentHeadSha: subject.headSha,
      verdict: 'issues',
      unresolvedFindings: [{ file: 'src/file.ts', line: 1, description: 'Earlier finding' }],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      reviewScope: 'incremental',
      validationDepth: 'static-code',
    },
  };
  const deps = {
    getRun: () => run,
    loadProjectVars: async () => project,
    loadPoolConfigs: async () => [
      { machine: 'local', host: 'localhost', sshUser: 'fixture' } as PoolConfig,
    ],
    snapshotRoot: () => path.join(root, 'gateway-snapshots'),
  };
  return { root, run, subject, project, deps, task: run.reviewWorkspace!.taskPath };
}

async function withFixture(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-owner';
  const f = await fixture();
  try {
    await work(f);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  }
}

test('materialization preserves canonical checklist, freezes offline guidance/prior findings and retries from its snapshot', async () => {
  await withFixture(async (f) => {
    f.run.reviewWorkspace!.support = {
      path: path.join(f.root, 'support'),
      sha256: 'f'.repeat(64),
      sources: [{ kind: 'skill', name: 'team-review', sourceRevision: 'd'.repeat(40) }],
      skills: [
        { name: 'team-review', path: path.join(f.root, 'support/skills/team-review/SKILL.md') },
      ],
      runtime: { name: 'review-tool', path: path.join(f.root, 'support/bin/review-tool') },
      environment: {},
    };
    const first = await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    assert.equal(await readFile(path.join(f.task, 'CHECKLIST.md'), 'utf8'), checklist);
    assert.match(await readFile(first.taskFile, 'utf8'), new RegExp(f.subject.headSha));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.task, 'inputs/review-support.json'), 'utf8')),
      f.run.reviewWorkspace!.support,
    );
    assert(
      (await readFile(first.taskFile, 'utf8')).includes(
        f.run.reviewWorkspace!.support.skills[0].path,
      ),
    );
    assert.equal(
      JSON.parse(await readFile(path.join(f.task, 'inputs/review-subject.json'), 'utf8')).headSha,
      f.subject.headSha,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(f.task, 'inputs/prior-review.json'), 'utf8'))
        .unresolvedFindings[0].description,
      'Earlier finding',
    );
    assert.match(
      await readFile(path.join(f.task, 'inputs/instructions/review-guide.md'), 'utf8'),
      /library revision abcdef/,
    );
    const handoff = JSON.parse(await readFile(path.join(f.task, 'inputs/handoff.json'), 'utf8'));
    assert.equal(handoff.executionTemplate.sha256, digest(checklist));
    assert.equal(handoff.executionTemplate.renderedSha256, digest(checklist));
    await writeFile(
      path.join(f.project.projectTemplatesDir, 'worker/review-pr.md'),
      '# Changed later',
    );
    await writeFile(path.join(f.project.projectFixturesDir, 'review-guide.md'), 'Changed later');
    assert.deepEqual(await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps), first);
    assert.equal(await readFile(path.join(f.task, 'CHECKLIST.md'), 'utf8'), checklist);
    assert.match(
      await readFile(path.join(f.task, 'inputs/instructions/review-guide.md'), 'utf8'),
      /library revision abcdef/,
    );
    await assert.rejects(
      materializeReviewWorkspaceTask(f.run.id, { ...f.subject, headSha: 'c'.repeat(40) }, f.deps),
      /subject changed/,
    );
    assert.equal(await readReviewWorkspaceCompletion(f.run.id, f.deps), null);
  });
});

test('the copied shared marker works offline; completion rejects wrong SHA, stale attempts and missing required evidence', async () => {
  await withFixture(async (f) => {
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const startedAt = new Date().toISOString();
    f.run.agentContexts = [
      {
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
          acceptedAt: startedAt,
          launchRequestedAt: startedAt,
        },
      },
    ];
    const mark = async (...args: string[]) =>
      exec(path.join(f.task, 'mark'), args, {
        cwd: f.task,
        env: { ...process.env, FARMSLOT_MARK_CMD: '' },
        maxBuffer: 256 * 1024,
      });
    await mark('start');
    const started = JSON.parse(await readFile(path.join(f.task, 'SIGNAL.json'), 'utf8'));
    f.run.agentContexts[0].signalAttemptId = started.attemptId;
    assert.equal(await readReviewWorkspaceCompletion(f.run.id, f.deps), null);
    const report = `VERDICT: APPROVE\nCOMMIT: ${f.subject.headSha}\nNo findings.\n`;
    const result = {
      schemaVersion: 1,
      verdict: 'pass',
      issues: [],
      runId: f.run.id,
      workspaceId: f.run.reviewWorkspace!.workspaceId,
      headSha: f.subject.headSha,
      baseSha: f.subject.baseSha,
      attemptId: started.attemptId,
      reportSha256: digest(report),
    };
    await writeFile(path.join(f.task, 'artifacts/review.md'), report);
    await writeFile(path.join(f.task, 'artifacts/review-result.json'), JSON.stringify(result));
    await writeFile(path.join(f.task, 'artifacts/line-comments.json'), '{"comments":[]}');
    await writeFile(
      path.join(f.task, 'artifacts/learnings.md'),
      '- No reusable learning from this fixture.\n',
    );
    await mark('1');
    await mark('complete', '--mark-last');
    const completion = await readReviewWorkspaceCompletion(f.run.id, f.deps);
    assert.equal(completion?.result?.recommendation, 'APPROVE');
    assert.equal(completion?.result?.reviewSnapshot?.headSha, f.subject.headSha);
    assert.equal(
      await readFile(
        path.join(f.deps.snapshotRoot(), f.run.id, 'view/artifacts/review.md'),
        'utf8',
      ),
      report,
    );
    assert(completion?.result?.artifactManifest?.some((entry) => entry.path.endsWith('review.md')));
    for (const file of ['CHECKLIST.md', 'SIGNAL.json']) {
      assert.equal(
        await readFile(path.join(f.deps.snapshotRoot(), f.run.id, 'view', file), 'utf8'),
        await readFile(path.join(f.task, file), 'utf8'),
      );
    }
    await writeFile(
      path.join(f.task, 'artifacts/review-result.json'),
      JSON.stringify({ ...result, headSha: 'c'.repeat(40) }),
    );
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /exact source/);
    await writeFile(
      path.join(f.task, 'artifacts/review-result.json'),
      JSON.stringify({ ...result, attemptId: 'older-attempt' }),
    );
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /exact source/);
    await writeFile(path.join(f.task, 'artifacts/review-result.json'), JSON.stringify(result));
    const findingsReport = report.replace('APPROVE', 'REQUEST_CHANGES');
    const finding = {
      file: 'src/file.ts',
      line: 1,
      description: 'Missing guard',
      severity: 'major',
    };
    const findingsResult = {
      ...result,
      verdict: 'issues',
      issues: [finding],
      reportSha256: digest(findingsReport),
    };
    await writeFile(path.join(f.task, 'artifacts/review.md'), findingsReport);
    await writeFile(
      path.join(f.task, 'artifacts/review-result.json'),
      JSON.stringify(findingsResult),
    );
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /line comments disagree/);
    await writeFile(
      path.join(f.task, 'artifacts/line-comments.json'),
      JSON.stringify({
        comments: [
          {
            path: finding.file,
            line: finding.line,
            body: finding.description,
            severity: finding.severity,
          },
        ],
      }),
    );
    assert.equal(
      (await readReviewWorkspaceCompletion(f.run.id, f.deps))?.result?.recommendation,
      'REQUEST_CHANGES',
    );
    await writeFile(path.join(f.task, 'artifacts/review.md'), report);
    await writeFile(
      path.join(f.task, 'artifacts/review-result.json'),
      JSON.stringify({ ...findingsResult, reportSha256: digest(report) }),
    );
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /Markdown verdict/);
    await writeFile(path.join(f.task, 'artifacts/review-result.json'), JSON.stringify(result));
    await writeFile(path.join(f.task, 'artifacts/line-comments.json'), '{"comments":[]}');
    await rm(path.join(f.task, 'artifacts/learnings.md'));
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /required/);
    await writeFile(path.join(f.task, 'CHECKLIST.md'), '- [x] A substituted shorter checklist.\n');
    await assert.rejects(readReviewWorkspaceCompletion(f.run.id, f.deps), /checklist/);
  });
});

test('a blocked marker retains its reason only for the accepted reviewer attempt', async () => {
  await withFixture(async (f) => {
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const acceptedAt = new Date(Date.now() - 1000).toISOString();
    f.run.agentContexts = [
      {
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
      },
    ];
    const mark = (...args: string[]) =>
      exec(path.join(f.task, 'mark'), args, {
        cwd: f.task,
        env: { ...process.env, FARMSLOT_MARK_CMD: '' },
      });
    await mark('start');
    const started = JSON.parse(await readFile(path.join(f.task, 'SIGNAL.json'), 'utf8'));
    f.run.agentContexts[0].signalAttemptId = started.attemptId;
    await mark('blocked', '--reason', 'Required review input is unavailable');
    const completion = await readReviewWorkspaceCompletion(f.run.id, f.deps);
    assert.equal(completion?.signal.status, 'blocked');
    assert.equal(completion?.signal.reason, 'Required review input is unavailable');
    assert.equal(completion?.result, null);
    const retainedSignal = JSON.parse(
      await readFile(path.join(f.deps.snapshotRoot(), f.run.id, 'view/SIGNAL.json'), 'utf8'),
    );
    assert.equal(retainedSignal.reason, 'Required review input is unavailable');
    f.run.agentContexts[0].signalAttemptId = 'another-attempt';
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, f.deps),
      /accepted worker attempt/,
    );
  });
});
