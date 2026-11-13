import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

import type { RunnerSessionUsage } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

await import('./mock-pty.test-support.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'native-archive-usage-'));
const previousRuns = process.env.FARMSLOT_RUNS_DIR;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
after(async () => {
  if (previousRuns === undefined) delete process.env.FARMSLOT_RUNS_DIR;
  else process.env.FARMSLOT_RUNS_DIR = previousRuns;
  await rm(root, { recursive: true, force: true });
});
const vars = makeVars({
  projectName: '',
  machineEnv: { LITELLM_URL: '', LITELLM_BASE_URL: '', LITELLM_API_KEY: '' },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => vars },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    // Substitute only transport. Run the node's production journal resolution and accounting.
    execNativeNodeArgv: async (_owner: string, _node: string, argv: string[]) =>
      promisify(execFile)(process.execPath, [
        ...argv.slice(1, -1),
        path.resolve(import.meta.dirname, '../../../../packages/slot-config/src/session-usage.ts'),
      ]),
  },
});
const { runnerSessionArchiveContextDir } = await import('../runners/session-archive.js');
const { extractRunWorkerSessionUsage, projectArchivedRunnerUsage } =
  await import('./session-usage.js');

for (const journalRetained of [true, false]) {
  test(`pruned native Claude transcript with journal retained=${journalRetained} preserves run attribution and siblings`, async () => {
    const directory = path.join(root, String(journalRetained));
    const stateDirectory = path.join(directory, 'workers/owner/host');
    await mkdir(stateDirectory, { recursive: true });
    await mkdir(path.join(directory, 'sessions'));
    const original = path.join(directory, 'conversation.jsonl');
    const sibling = path.join(directory, 'sibling.jsonl');
    // The node clock is 30s ahead of lifecycle metadata. Include both adjacent runs.
    const assistant = (id: string, timestamp: string, input: number) => ({
      type: 'assistant',
      sessionId: 'conversation',
      timestamp,
      message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: 1 } },
    });
    const bytes =
      [
        assistant('prior', '2026-01-02T00:00:29Z', 100),
        assistant('warm', '2026-01-02T00:00:31Z', 20),
        assistant('next', '2026-01-02T00:00:40Z', 300),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n';
    await writeFile(original, bytes);
    await writeFile(
      sibling,
      JSON.stringify(assistant('sibling', '2026-01-02T00:00:01Z', 5)) + '\n',
    );
    const run = makeRun({
      id: `archive-${journalRetained}`,
      flowType: 'dev',
      slotId: vars.slotId,
      createdAt: '2026-01-02T00:00:00Z',
      completedAt: '2026-01-02T00:00:10Z',
      metrics: { nudgeCount: 0, runner: 'claude', model: 'opus', runnerSessionPath: original },
    });
    const archiveDir = runnerSessionArchiveContextDir(run.id, 'dev');
    await mkdir(archiveDir, { recursive: true });
    await copyFile(original, path.join(archiveDir, 'transcript.jsonl'));
    await rm(original);
    run.agentContexts = [
      {
        id: 'dev',
        role: 'dev',
        label: 'Development',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        runnerSessionId: 'conversation',
        runnerSessionPath: original,
        status: 'complete',
        startedAt: run.createdAt,
        completedAt: run.completedAt,
        nativeSession: {
          sessionId: 'host',
          ownerPrincipalId: 'owner',
          executionNodeId: vars.machine,
          stateDirectory,
          leaseId: 'warm',
          commandId: 'warm-command',
        },
        runnerSessionArchive: {
          status: 'captured',
          kind: 'jsonl',
          runner: 'claude',
          originalPath: original,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        runId: run.id,
        slotId: vars.slotId,
        runner: 'claude',
        runnerSessionId: 'sibling',
        runnerSessionPath: sibling,
        status: 'complete',
        startedAt: run.createdAt,
      },
    ];
    if (journalRetained)
      await writeFile(
        path.join(directory, 'sessions/host.journal'),
        [
          {
            context: { home: directory, claudeConfigDir: path.join(directory, 'claude') },
            info: {
              id: 'host',
              nativeSessionId: 'conversation',
              runner: 'claude',
              ownerPrincipalId: 'owner',
              executionNodeId: vars.machine,
              cwd: directory,
            },
          },
          {
            commands: [{ commandId: 'warm-command', leaseId: 'warm' }],
            event: {
              type: 'command.submitted',
              commandId: 'warm-command',
              at: '2026-01-02T00:00:30Z',
            },
          },
          {
            commands: [{ commandId: 'next-command', leaseId: 'next' }],
            event: {
              type: 'command.submitted',
              commandId: 'next-command',
              at: '2026-01-02T00:00:40Z',
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n',
      );
    const receipts: RunnerSessionUsage[] = [];
    const usage = await extractRunWorkerSessionUsage(run, vars, (_session, receipt) =>
      receipts.push(receipt),
    );
    assert.equal(receipts.length, 2, 'Archive recovery must retain sibling captures');
    assert.equal(receipts[1].totalTokens, 6);
    if (journalRetained) {
      assert.equal(usage?.totalTokens, 27, usage?.error);
      assert.equal(receipts[0].totalTokens, 21);
      assert.equal(receipts[0].scope, 'run-delta');
      const projected = await projectArchivedRunnerUsage(run);
      assert.equal(projected.metrics.sessionTotalTokens, 27);
      assert.equal(projected.metrics.sessionUsageError, undefined);
      await writeFile(path.join(archiveDir, 'transcript.jsonl'), 'corrupt archive');
      const failedReceipts: RunnerSessionUsage[] = [];
      const failed = await extractRunWorkerSessionUsage(run, vars, (_session, receipt) =>
        failedReceipts.push(receipt),
      );
      assert.equal(failed?.source, 'unavailable');
      assert.equal(failedReceipts.length, 2);
      assert.match(failedReceipts[0].error ?? '', /SHA256/);
      assert.equal(failedReceipts[1].totalTokens, 6);
    } else {
      assert.equal(usage?.source, 'unavailable');
      assert.equal(receipts[0].totalTokens, undefined);
      const projected = await projectArchivedRunnerUsage(run);
      assert.equal(
        projected.metrics.sessionTotalTokens,
        undefined,
        'Never fall back to the archive chain total',
      );
      assert.match(projected.metrics.sessionUsageError ?? '', /journal|ENOENT/);
      // No recovered worker sessions, as with a slotless historical native run.
      const slotless = { ...run, slotId: null };
      const unavailable = await projectArchivedRunnerUsage(slotless);
      assert.equal(unavailable.metrics.sessionTotalTokens, undefined);
      assert.match(unavailable.metrics.sessionUsageError ?? '', /[Nn]ative.*boundary/);
    }
  });
}
