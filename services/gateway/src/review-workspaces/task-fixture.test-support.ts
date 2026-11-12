import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ReviewWorkspaceSubject, Run } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { resolveConfiguredExecutionTemplate } from '../tasks/execution-template-catalog.js';

export const checklist = '# Review\n\n- [ ] Read the exact diff.\n- [ ] Write review artifacts.\n';

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
  const selection = await resolveConfiguredExecutionTemplate(project, {
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

      priorRunId: 'previous',
      priorFamilyId: 'family',
      repository: subject.repository,
      prNumber: 1,
      currentHeadSha: subject.headSha,
      verdict: 'issues',
      unresolvedFindings: [{ file: 'src/file.ts', line: 1, description: 'Earlier finding' }],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode: 'warm',
      validationDepth: 'static-code',
    },
  };
  const poolDir = path.join(root, 'pool');
  await mkdir(poolDir);
  const machine = {
    machine: 'local',
    host: 'localhost',
    ssh_user: 'fixture',
    platform: 'cli',
    os: 'linux',
    slots: [],
  };
  await writeFile(
    path.join(poolDir, 'local.json'),
    JSON.stringify({ ...machine, project: 'fixture', review_workspaces: { max_concurrent: 2 } }),
  );
  await writeFile(
    path.join(poolDir, 'canary-local.json'),
    JSON.stringify({ ...machine, project: 'canary' }),
  );
  const deps = {
    getRun: () => run,
    loadProjectVars: async () => project,
    loadPoolConfigs: () => loadPoolConfigs(poolDir),
    snapshotRoot: () => path.join(root, 'gateway-snapshots'),
    readCommentDiff: async () => '@@ -1 +1 @@\n unchanged\n',
  };
  return { root, run, subject, project, deps, task: run.reviewWorkspace!.taskPath };
}

export async function withReviewWorkspaceTaskFixture(
  work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
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
