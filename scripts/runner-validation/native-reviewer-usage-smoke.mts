// Private gateway/node proof: shared accounting through real slot-action RPC, then dispatch/cancel.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  nativeSessionUsageArgv,
  type NativeSessionUsageRequest,
} from '../../services/gateway/src/runners/native-session-usage-command.js';
import { parseSessionUsageOutput } from '../../services/gateway/src/runtime/session-usage-result.js';
import type { Run, SlotActionRunResult } from '../../packages/protocol/src/index.js';
import { projectPacks, PIPE_PROJECT, SEED, slotCli, pipeRunParams } from './canary/fixtures.mjs';
import { startRemoteNodeStack } from './lib/remote-node-stack.mjs';
import { startReaper, cleanupOnExit, listProcesses } from './lib/isolated-stack.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.resolve(process.argv[2] ?? '/tmp/native-reviewer-usage-evidence');
await mkdir(evidence, { recursive: true });
const slotId = PIPE_PROJECT + '-1';
const requests = ['claude', 'codex'].map(
  (runner) =>
    ({
      key: runner,
      runner,
      provider: runner + '-jsonl',
      runnerSessionId: randomUUID(),
      cwd: '{{repo}}',
      slotId,
      nativeSession: {
        sessionId: randomUUID(),
        executionNodeId: 'proof-node',
        ownerPrincipalId: 'test-automation',
        stateDirectory: `{{repo}}/.usage-proof/${runner}/workers/owner/session`,
      },
    }) satisfies NativeSessionUsageRequest,
);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const actions = Object.fromEntries(
  requests.map((request) => [
    request.key,
    {
      label: 'Read owned usage fixture',
      command: nativeSessionUsageArgv([request]).map(quote).join(' '),
    },
  ]),
);
const reaper = startReaper();
let stack: Awaited<ReturnType<typeof startRemoteNodeStack>> | undefined;
const cleanup = cleanupOnExit(async () => {
  if (stack)
    for (const error of await stack.cleanup()) {
      const { existsSync } = await import('node:fs');
      if (
        error.startsWith('tmux:') &&
        !existsSync(stack.fixture) &&
        !listProcesses().some((process) => process.command.includes(stack!.fixture))
      )
        continue;
      assert.fail(error);
    }
  reaper.done();
});
try {
  stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'proof-node',
    slots: [slotId],
    projects: (holds) =>
      projectPacks(holds)
        .filter((pack) => pack.name === PIPE_PROJECT)
        .map((pack) => ({ ...pack, projectJson: { ...pack.projectJson, slot_actions: actions } })),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.resolve(process.argv[3] ?? path.join(evidence, 'cli-snapshots')),
    ownerTag: 'f404-reviewer-usage',
    reaper,
    log: async (event, detail) => console.log(event, JSON.stringify(detail ?? {})),
  });
  const created = await stack.call<{ run: Run }>('run.create', pipeRunParams(slotId));
  const runId = created.run.id;
  let current: Run;
  const deadline = Date.now() + 180000;
  for (;;) {
    current = (await stack.call<{ run: Run }>('run.get', { runId })).run;
    if (current.steps.find((step) => step.name === 'dispatch')?.status === 'done') break;
    assert(!['failed', 'blocked', 'cancelled'].includes(current.status), current.error);
    assert(Date.now() < deadline, 'Dispatch deadline');
    await delay(100);
  }
  assert(
    current.steps
      .filter((step) => ['write-task', 'prepare'].includes(step.name))
      .every((step) => step.status === 'done'),
  );
  const totals = [];
  for (const template of requests) {
    const repo = stack.slotRepo(slotId);
    const state = template.nativeSession.stateDirectory.replace('{{repo}}', repo);
    const native = path.resolve(state, '../../..');
    const claude = path.join(repo, '.usage-proof/claude/account');
    const codex = path.join(state, 'codex-home');
    for (const dir of [state, path.join(native, 'sessions'), claude, codex])
      await mkdir(dir, { recursive: true });
    const journal = {
      context: { home: repo, claudeConfigDir: claude, codexHome: '' },
      info: {
        id: template.nativeSession.sessionId,
        nativeSessionId: template.runnerSessionId,
        runner: template.runner,
        ownerPrincipalId: template.nativeSession.ownerPrincipalId,
        executionNodeId: 'proof-node',
        cwd: repo,
      },
    };
    await writeFile(
      path.join(native, 'sessions', template.nativeSession.sessionId + '.journal'),
      JSON.stringify(journal) + '\n',
    );
    const file =
      template.runner === 'claude'
        ? path.join(
            claude,
            'projects',
            repo.replace(/[^a-zA-Z0-9]/g, '-'),
            template.runnerSessionId + '.jsonl',
          )
        : path.join(codex, 'sessions/record.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    const records =
      template.runner === 'claude'
        ? [
            {
              type: 'assistant',
              sessionId: template.runnerSessionId,
              message: {
                id: 'one',
                model: 'claude-opus-5-5',
                usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
              },
            },
          ]
        : [
            { type: 'session_meta', payload: { id: template.runnerSessionId, cwd: repo } },
            { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
            {
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: {
                  total_token_usage: {
                    input_tokens: 150,
                    output_tokens: 250,
                    total_tokens: 400,
                    cached_input_tokens: 40,
                  },
                },
              },
            },
          ];
    const bytes = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(file, bytes);
    if (template.runner === 'codex') {
      const database = new DatabaseSync(path.join(codex, 'state_5.sqlite'));
      database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
      database.prepare('INSERT INTO threads VALUES (?, ?)').run(template.runnerSessionId, file);
      database.close();
    }
    const action = await stack.call<SlotActionRunResult>('slot.action.run', {
      slotId,
      actionId: 'slot:' + template.key,
    });
    assert(action.ok, action.stderr ?? action.detail);
    const rows: unknown = JSON.parse(action.stdout ?? '');
    assert(Array.isArray(rows) && rows.length === 1);
    const row: unknown = rows[0];
    assert(
      row &&
        typeof row === 'object' &&
        'output' in row &&
        typeof row.output === 'string' &&
        'sessionPath' in row &&
        typeof row.sessionPath === 'string',
    );
    const usage = parseSessionUsageOutput(row.output, {
      runner: template.runner,
      runnerSessionId: template.runnerSessionId,
      runnerSessionPath: row.sessionPath,
    });
    assert.equal(usage.outputTokens, template.runner === 'claude' ? 20 : 250);
    assert.equal(await readFile(file, 'utf8'), bytes);
    totals.push(usage);
  }
  await stack.call('run.cancel', { runId });
  assert.equal((await stack.call<{ run: Run }>('run.get', { runId })).run.status, 'cancelled');
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], {
          cwd: root,
          encoding: 'utf8',
        }).trim(),
        runId,
        totals,
        node: 'proof-node',
        realSlotActionRpc: true,
        prepareAndDispatch: true,
        finalStatus: 'cancelled',
        transcriptsUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log('PASS', runId);
} finally {
  await cleanup();
}
