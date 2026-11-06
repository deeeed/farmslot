// Opt-in recovery proof. Owns its gateway, home and task; never starts a reviewer or model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { RunGetResult, RunReplayStepResult, RunResumeResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

const source = fileURLToPath(new URL('../../../../', import.meta.url));
const exec = promisify(execFile);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test(
  'stopped review fails, empty replay refuses without mutation, and valid retained output remains recoverable',
  { timeout: 60_000 },
  async (t) => {
    const output = process.env.FARMSLOT_REVIEW_RECOVERY_PROOF_OUT;
    assert(output, 'Set FARMSLOT_REVIEW_RECOVERY_PROOF_OUT');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-recovery-rpc-'));
    let fixtureOwnsRoot = false;
    t.after(() => (fixtureOwnsRoot ? undefined : rm(root, { recursive: true, force: true })));
    Object.assign(process.env, {
      NODE_TEST_CONTEXT: '1',
      FARMSLOT_ROOT: root,
      FARMSLOT_HOME: path.join(root, 'home'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      TMUX_TMPDIR: path.join(root, 'tmux'),
    });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    for (const name of [
      'scripts',
      'packages',
      'services',
      'node_modules',
      'schemas',
      'package.json',
      'CLAUDE.md',
    ])
      await symlink(path.join(source, name), path.join(root, name));
    for (const name of ['home', 'pool', 'tmux', 'projects/fixture/templates/worker', 'source'])
      await mkdir(path.join(root, name), { recursive: true });
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), slots: [] }),
    );
    await writeFile(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        machine: 'local',
        host: 'localhost',
        ssh_user: os.userInfo().username,
        project: 'fixture',
        platform: 'cli',
        slots: [],
        review_workspaces: { max_concurrent: 2 },
      }),
    );
    await writeFile(
      path.join(root, 'projects/fixture/project.json'),
      JSON.stringify({
        name: 'fixture',
        execution_templates: {},
        static_review: { template_id: 'review-pr/default', instruction_files: [] },
        hooks: {},
      }),
    );
    await writeFile(
      path.join(root, 'projects/fixture/templates/worker/review-pr.md'),
      '# Review\n\n- [ ] Read exact diff.\n- [ ] Write artifacts.\n',
    );
    // No PTY attaches. Inventory reads use an unused, fixture-owned TMUX_TMPDIR.
    const noPty = () => {
      throw new Error('No PTY operation in review recovery proof');
    };
    mock.module('../runtime/pty-stream.js', {
      namedExports: {
        onPtyExit: () => () => {},
        ptyExitHandlerCountForTests: () => 0,
        subscribePty: noPty,
        unsubscribePty: noPty,
        unsubscribeAllPty: noPty,
        writePty: noPty,
        resizePty: noPty,
        hasPty: () => false,
        reinitTmuxSession: noPty,
      },
    });
    const fixture = await createNativeProofFixture(t, root);
    fixtureOwnsRoot = true;
    const store = await import('../runs/store.js');
    const { initServerGlobals, resetServerGlobalsForTests } = await import('../server.js');
    initServerGlobals();
    t.after(resetServerGlobalsForTests);
    const connection = await fixture.client.connect();
    t.after(() => connection.close());
    const call = <T>(method: string, params: unknown) => connection.call<T>(method, params);
    const project = await (await import('../core/config.js')).loadProjectVars('fixture');
    const selection = (
      await import('../tasks/execution-template-catalog.js')
    ).resolveConfiguredExecutionTemplate(project, {
      flow: 'review-pr',
      platform: 'web',
      runMode: 'autonomous',
    });
    const subject = {
      repository: 'example/fixture',
      repositoryUrl: 'https://github.com/example/fixture.git',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'fixture',
      title: 'Fixture',
      body: '',
      capturedAt: new Date().toISOString(),
    };
    const run = store.createRun(
      {
        project: 'fixture',
        flowType: 'review-pr',
        mode: 'autonomous',
        ticketOrPr: 'example/fixture#1',
        runner: 'codex',
        model: 'gpt-6.1-sol',
        transport: 'tmux',
        reviewWorkspaceTarget: { machine: 'local' },
      },
      { nativeOwnerPrincipalId: fixture.person.id },
    );
    store.updateRun(run.id, {
      executionTemplate: selection.reference,
      reviewWorkspaceSubject: subject,
      reviewWorkspace: {
        workspaceId: 'fixture-workspace',
        machine: 'local',
        executionNodeId: 'local',
        checkoutPath: path.join(root, 'source'),
        taskPath: path.join(root, 'task'),
        artifactPath: path.join(root, 'task/artifacts'),
      },
    });
    const taskApi = await import('./task.js');
    const materialized = await taskApi.materializeReviewWorkspaceTask(run.id, subject);
    const task = path.join(root, 'task');
    const started = new Date().toISOString();
    const mark = (...args: string[]) =>
      exec(path.join(task, 'mark'), args, {
        cwd: task,
        env: { ...process.env, FARMSLOT_MARK_CMD: '' },
      });
    await mark('start');
    const signal = JSON.parse(await readFile(path.join(task, 'SIGNAL.json'), 'utf8'));
    store.updateRun(run.id, {
      status: 'paused',
      taskFile: materialized.taskFile,
      steps: [
        { name: 'find-slot', status: 'done' },
        { name: 'write-task', status: 'done' },
        { name: 'prepare', status: 'done' },
        { name: 'dispatch', status: 'done' },
        { name: 'monitor', status: 'running', startedAt: started },
        { name: 'human-gate', status: 'pending' },
        { name: 'complete', status: 'pending' },
      ],
      agentContexts: [
        {
          id: 'review',
          role: 'review',
          label: 'Absent reviewer fixture',
          slotId: null,
          runId: run.id,
          status: 'waiting',
          runner: 'codex',
          model: 'gpt-6.1-sol',
          target: { session: 'review-fixture-workspace', target: 'review-fixture-workspace' },
          promptDeliveryStartedAt: started,
          attemptStartedAt: started,
          signalAttemptId: signal.attemptId,
        },
      ],
    });
    await call<RunResumeResult>('run.resume', { runId: run.id });
    let observed = (await call<RunGetResult>('run.get', { runId: run.id })).run;
    const deadline = Date.now() + 10000;
    while (
      !['failed', 'reconciling'].includes(observed.status) ||
      (observed.status === 'failed' && !observed.reviewWorkspace?.executionStoppedAt)
    ) {
      assert(Date.now() < deadline, 'Stopped reviewer did not settle');
      await new Promise((resolve) => setTimeout(resolve, 20));
      observed = (await call<RunGetResult>('run.get', { runId: run.id })).run;
    }
    await writeFile(
      path.join(output, 'stopped.json'),
      JSON.stringify(
        { id: run.id, status: observed.status, error: observed.error, steps: observed.steps },
        null,
        2,
      ),
    );
    assert.equal(observed.status, 'failed', 'A known stopped reviewer must not remain reconciling');
    assert.equal(observed.steps.find((step) => step.name === 'monitor')?.status, 'failed');
    const generation = observed.engineState?.generation;
    await assert.rejects(
      call('run.replayStep', { runId: run.id, stepName: 'monitor' }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'REVIEW_RESTART_REQUIRED',
    );
    assert.equal(
      (await call<RunGetResult>('run.get', { runId: run.id })).run.engineState?.generation,
      generation,
    );
    const report = `VERDICT: APPROVE\nCOMMIT: ${subject.headSha}\nNo findings.\n`;
    await writeFile(path.join(task, 'artifacts/review.md'), report);
    await writeFile(
      path.join(task, 'artifacts/review-result.json'),
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'pass',
        issues: [],
        runId: run.id,
        workspaceId: 'fixture-workspace',
        headSha: subject.headSha,
        baseSha: subject.baseSha,
        attemptId: signal.attemptId,
        reportSha256: digest(report),
      }),
    );
    await writeFile(path.join(task, 'artifacts/line-comments.json'), '{"comments":[]}');
    await writeFile(path.join(task, 'artifacts/learnings.md'), '- Fixture only.\n');
    await mark('1');
    await mark('complete', '--mark-last');
    const replay = await call<RunReplayStepResult>('run.replayStep', {
      runId: run.id,
      stepName: 'monitor',
    });
    assert((replay.run.engineState?.generation ?? 0) > (generation ?? 0));
    await call('run.cancel', { runId: run.id });
    await writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          pass: true,
          runId: run.id,
          stoppedStatus: observed.status,
          emptyReplayRefused: true,
          validSavedReplayAdmitted: true,
          inferenceCalls: 0,
          publicationActions: 0,
        },
        null,
        2,
      ),
    );
  },
);
