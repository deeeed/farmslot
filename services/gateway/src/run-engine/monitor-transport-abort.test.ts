// @farmslot:serial — owns temporary project and pool rows in this checkout.
// F328 ce1c5583, 2026-11-02: a gateway restart resumed the monitor of a live Pi worker whose
// model stream had just been torn down ("terminated"). The monitor failed the run on that turn
// error, and the failure teardown sent /exit to the worker.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WorkerSignal } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { farmslotRoot } from '../fleet/state.js';
import type {
  ObservabilityReading,
  RunnerSessionDeliveryState,
} from '../runners/observability-types.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import { checkAgentLive, monitorRun } from './run-monitor.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

test(
  'a recovered monitor keeps watching a worker whose model stream dropped and ends on its signal',
  { timeout: 4000 },
  async (t) => {
    const project = `transport-abort-${randomUUID()}`;
    const projectDir = path.join(farmslotRoot, 'projects', project);
    const poolFile = path.join(farmslotRoot, 'pool', `${project}.json`);
    const worker = await mkdtemp(path.join(os.tmpdir(), 'transport-abort-'));
    const taskDir = path.join(projectDir, 'tasks/dev/fixture');
    const signalFile = path.join(worker, 'SIGNAL.json');
    const slotId = `${project}-slot`;
    const controller = new AbortController();
    const run = createRun({
      project,
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'TAT-4355',
      runner: 'pi',
    });
    t.after(async () => {
      controller.abort();
      await deleteTestRunIfPresent(run.id);
      await rm(projectDir, { recursive: true, force: true });
      await rm(poolFile, { force: true });
      await rm(worker, { recursive: true, force: true });
    });
    await mkdir(taskDir, { recursive: true });
    await mkdir(path.dirname(poolFile), { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        name: project,
        monitoring: { poll_interval_min: 1 / 60_000, total_timeout_min: 1, max_nudges: 0 },
      }),
    );
    await writeFile(
      poolFile,
      JSON.stringify({
        machine: 'localhost',
        project,
        host: 'localhost',
        ssh_user: os.userInfo().username,
        platform: 'cli',
        os: 'darwin',
        slots: [{ id: slotId, enabled: true, repo: worker, session: slotId }],
      }),
    );
    await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
    const startedAt = new Date(Date.now() - 600_000).toISOString();
    const signal = (status: WorkerSignal['status']): WorkerSignal => ({
      status,
      attemptId: 'owned-attempt',
      role: 'dev',
      contextId: 'worker',
      timestamp: new Date().toISOString(),
      ...(status === 'blocked' ? { reason: 'Needs a product decision' } : {}),
    });
    await writeFile(signalFile, JSON.stringify(signal('running')));
    updateRun(run.id, {
      status: 'monitoring',
      slotId,
      taskFile: path.join(taskDir, 'TASK.md'),
      agentContexts: [
        {
          id: 'worker',
          role: 'dev',
          label: 'Worker',
          runner: 'pi',
          status: 'working',
          runId: run.id,
          slotId,
          signalAttemptId: 'owned-attempt',
          signalFile,
          taskFile: path.join(worker, 'TASK.md'),
          startedAt,
          attemptStartedAt: startedAt,
        },
      ],
      // Restart recovery resumes from the persisted monitor state.
      monitorState: {
        nudgeCount: 0,
        startedAt,
        lastPollAt: startedAt,
        lastStructuredProgressAt: startedAt,
      },
    });

    // The live Pi pane, whose last turn ended on undici's bare "terminated".
    const readers = {
      slot: async () => makeVars({ slotId, session: slotId }),
      target: async () => ({ target: `${slotId}:dev`, session: slotId }),
      exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
      process: async () => ({ state: 'present' as const, pid: '99' }),
      turn: async (): Promise<ObservabilityReading<RunnerSessionDeliveryState>> => ({
        value: 'idle',
        source: 'hook',
        confidence: 'high',
        observedAt: Date.now(),
        failure: 'terminated',
      }),
    };
    let observed = 0;
    const result = await monitorRun(run.id, slotId, controller.signal, {
      workerStatus: async (slot, runner, runId, role, contextId) => {
        const status = await checkAgentLive(slot, runner, runId, role, contextId, readers);
        // Nudged on, the worker reaches its own outcome.
        if (++observed === 1) await writeFile(signalFile, JSON.stringify(signal('blocked')));
        return status;
      },
      violations: async () => [],
    });

    assert.equal(observed, 1);
    assert.equal(result.exitReason, 'worker-done');
    assert.equal(result.workerSignal?.status, 'blocked');
    assert.equal(result.workerSignal?.reason, 'Needs a product decision');
    assert.deepEqual(getRun(run.id)?.decisions, []);
  },
);
