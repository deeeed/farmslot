import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runSessionUsage } from '@farmslot/slot-config';

import { parseSessionUsageOutput } from '../runtime/session-usage-result.js';

import {
  forcedSessionUsageArgv,
  nativeSessionUsageArgv,
  type NativeSessionUsageRequest,
} from './native-session-usage-command.js';

const execute = promisify(execFile);
const modulePath = fileURLToPath(
  new URL('../../../../packages/slot-config/src/session-usage.ts', import.meta.url),
);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-review-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'worktree');
  const claude = path.join(root, 'profile-claude');
  const codex = path.join(root, 'native/workers/owner/host-session/codex-home');
  const native = path.join(root, 'native');
  const state = path.join(native, 'workers/owner/host-session');
  for (const directory of [cwd, claude, codex, state, path.join(native, 'sessions')])
    await mkdir(directory, { recursive: true });
  const request = (runner: string): NativeSessionUsageRequest => ({
    key: runner,
    runner,
    provider: runner + '-jsonl',
    runnerSessionId: 'conversation-' + runner,
    slotId: 'proof-slot',
    cwd,
    nativeSession: {
      sessionId: 'host-session',
      ownerPrincipalId: 'owner',
      executionNodeId: 'proof-node',
      stateDirectory: state,
    },
  });
  const journal = async (runner: string, owner = 'owner') =>
    writeFile(
      path.join(native, 'sessions/host-session.journal'),
      JSON.stringify({
        context: {
          home: root,
          claudeConfigDir: claude,
          codexHome: runner === 'codex' ? '' : codex,
        },
        info: {
          id: 'host-session',
          nativeSessionId: 'conversation-' + runner,
          runner,
          ownerPrincipalId: owner,
          executionNodeId: 'proof-node',
          cwd,
        },
      }) + '\n',
    );
  const run = async (requests: NativeSessionUsageRequest[]) => {
    const argv = nativeSessionUsageArgv(requests, modulePath);
    const result = await execute(process.execPath, argv.slice(1), {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      env: { ...process.env, HOME: root, CODEX_HOME: '', FORCE_COLOR: '0' },
    });
    const rows: unknown = JSON.parse(result.stdout);
    assert(Array.isArray(rows));
    return rows.map((row: unknown) => {
      assert(row && typeof row === 'object');
      return row;
    });
  };
  return { root, cwd, claude, codex, request, journal, run };
}

test('exact native profile/session accounting reuses worker totals for both runners and warm reads', async (t) => {
  const f = await fixture(t);
  for (const runner of ['claude', 'codex']) {
    const request = f.request(runner);
    await f.journal(runner);
    let transcript: string;
    let records: object[];
    if (runner === 'claude') {
      transcript = path.join(
        f.claude,
        'projects',
        f.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
        request.runnerSessionId + '.jsonl',
      );
      records = [
        {
          type: 'assistant',
          sessionId: request.runnerSessionId,
          message: {
            id: 'one',
            model: 'claude-opus-5-5',
            usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_creation_input_tokens: 30,
              cache_read_input_tokens: 400,
            },
          },
        },
      ];
    } else {
      transcript = path.join(f.codex, 'sessions/2026/11/05/record.jsonl');
      records = [
        { type: 'session_meta', payload: { id: request.runnerSessionId, cwd: f.cwd } },
        { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                output_tokens: 200,
                cached_input_tokens: 30,
                total_tokens: 300,
              },
            },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 150,
                output_tokens: 250,
                cached_input_tokens: 40,
                total_tokens: 400,
              },
            },
          },
        },
      ];
      const database = new DatabaseSync(path.join(f.codex, 'state_5.sqlite'));
      database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)');
      database
        .prepare('INSERT INTO threads VALUES (?, ?, ?)')
        .run(request.runnerSessionId, transcript, f.cwd);
      database.close();
    }
    await mkdir(path.dirname(transcript), { recursive: true });
    const bytes = records.map((row) => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(transcript, bytes);
    const expected = await runSessionUsage({
      repo: f.cwd,
      slotId: request.slotId,
      action: 'total',
      forcedPath: transcript,
      forcedRunner: runner,
    });
    const rows = await f.run([request, { ...request, key: 'warm' }]);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert('output' in row && typeof row.output === 'string');
      assert.equal(row.output, expected);
      assert('sessionPath' in row);
      assert.equal(row.sessionPath, await realpath(transcript));
    }
    if (runner === 'codex') assert.match(expected, /total_tokens=400/);
    assert.equal(
      await readFile(transcript, 'utf8'),
      bytes,
      'Accounting never edits learning records',
    );
  }
});

test('foreign native owner and mismatched transcript ids remain unavailable', async (t) => {
  const f = await fixture(t);
  await f.journal('claude', 'foreign-owner');
  const rows = await f.run([f.request('claude')]);
  assert('error' in rows[0]);
  assert.match(String(rows[0].error), /owner\/node/);
  assert(!('output' in rows[0]));
  await f.journal('claude');
  const file = path.join(
    f.claude,
    'projects',
    f.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    'conversation-claude.jsonl',
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ type: 'assistant', sessionId: 'other-conversation' }) + '\n',
  );
  const mismatch = await f.run([f.request('claude')]);
  assert('error' in mismatch[0]);
  assert.match(String(mismatch[0].error), /identity mismatch/);
  assert(!('output' in mismatch[0]));
});

test('native Pi accounting uses supplied worker prices rather than the node process environment', async (t) => {
  const f = await fixture(t);
  const request: NativeSessionUsageRequest = {
    ...f.request('pi'),
    liteLlmPrices: [['fixture-priced', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }]],
  };
  const transcript = path.join(f.root, 'pi.jsonl');
  request.sessionPath = transcript;
  request.nativeSession = undefined;
  await writeFile(
    transcript,
    [
      { type: 'session', id: request.runnerSessionId },
      {
        type: 'message',
        message: {
          role: 'assistant',
          provider: 'litellm',
          model: 'fixture-priced',
          usage: { input: 4, output: 4, cacheRead: 38195, cacheWrite: 0, cost: { total: 0 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const [row] = await f.run([request]);
  assert.ok('output' in row && typeof row.output === 'string');
  assert.match(row.output, /cost_usd=0\.0076870000/);
});

test('native resumed receipts count only first-seen messages in each run window', async (t) => {
  const f = await fixture(t);
  const request = f.request('claude');
  const transcript = path.join(f.root, 'resumed.jsonl');
  const assistant = (id: string, timestamp: string, input: number, output: number) => ({
    type: 'assistant',
    sessionId: request.runnerSessionId,
    timestamp,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: input * 2,
        cache_read_input_tokens: input * 10,
      },
    },
  });
  const cold = assistant('cold', '2026-01-01T00:01:00Z', 100, 200);
  const warm = assistant('warm', '2026-01-02T00:01:00Z', 20, 30);
  const retry = assistant('retry', '2026-01-02T00:02:00Z', 5, 7);
  const next = assistant('next', '2026-01-03T00:01:00Z', 3, 4);
  await writeFile(
    transcript,
    [
      cold,
      cold,
      { ...cold, timestamp: warm.timestamp },
      { ...warm, message: { ...warm.message, usage: {} } },
      warm,
      warm,
      { type: 'system', subtype: 'compact_boundary', timestamp: retry.timestamp },
      retry,
      retry,
      next,
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  request.sessionPath = transcript;
  const rows = await f.run([
    { ...request, key: 'cold' },
    Object.assign(
      { ...request, key: 'warm' },
      {
        usageWindow: {
          startedAt: '2026-01-02T00:00:00Z',
          completedAt: '2026-01-02T01:00:00Z',
        },
      },
    ),
    Object.assign(
      { ...request, key: 'next' },
      { usageWindow: { startedAt: '2026-01-03T00:00:00Z' } },
    ),
  ]);
  assert('output' in rows[0] && typeof rows[0].output === 'string');
  assert.match(rows[0].output, /input_tokens=128\n/);
  assert('output' in rows[1] && typeof rows[1].output === 'string');
  assert.match(rows[1].output, /turns=2\n/);
  assert.match(
    rows[1].output,
    /input_tokens=25\noutput_tokens=37\ncache_creation=50\ncache_read=250\n/,
  );
  assert.match(rows[1].output, /cost_usd=0.0011900000/);
  assert('output' in rows[2] && typeof rows[2].output === 'string');
  assert.match(rows[2].output, /input_tokens=3\noutput_tokens=4\n/);
});

test('native accounting refuses an older installed module that ignores run windows', async (t) => {
  const f = await fixture(t);
  const transcript = path.join(f.root, 'session.jsonl');
  const legacyModule = path.join(f.root, 'legacy.mjs');
  const request = f.request('claude');
  request.sessionPath = transcript;
  request.usageWindow = { startedAt: '2026-01-02T00:00:00Z' };
  await writeFile(transcript, JSON.stringify({ sessionId: request.runnerSessionId }) + '\n');
  await writeFile(
    legacyModule,
    'export async function runSessionUsage() { return "total_tokens=999\\n"; }',
  );
  const argv = nativeSessionUsageArgv([request], legacyModule);
  const result = await execute(process.execPath, argv.slice(1));
  assert.match(result.stdout, /did not apply the requested run usage window/);
  assert(!result.stdout.includes('total_tokens=999'));
});

for (const runner of ['claude', 'codex', 'pi'])
  for (const skew of [-30_000, 30_000]) {
    test(`native ${runner} accounting uses node journal boundaries with clock skew ${skew}ms`, async (t) => {
      const f = await fixture(t);
      await f.journal(runner);
      const request = f.request(runner);
      const journal = path.join(f.root, 'native/sessions/host-session.journal');
      const nodeStart = Date.parse('2026-01-02T00:00:00Z') + skew;
      const at = (offset: number) => new Date(nodeStart + offset).toISOString();
      await writeFile(
        journal,
        (await readFile(journal, 'utf8')) +
          [
            {
              commands: [{ commandId: 'warm-command', leaseId: 'warm' }],
              event: { type: 'command.submitted', commandId: 'warm-command', at: at(0) },
            },
            {
              commands: [{ commandId: 'next-command', leaseId: 'next' }],
              event: { type: 'command.submitted', commandId: 'next-command', at: at(10_000) },
            },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n') +
          '\n',
      );
      const message = (id: string, offset: number, input: number) =>
        runner === 'codex'
          ? {
              type: 'event_msg',
              timestamp: at(offset),
              payload: {
                type: 'token_count',
                info: {
                  total_token_usage: {
                    input_tokens: input,
                    output_tokens: input === 100 ? 1 : input === 120 ? 2 : 3,
                    total_tokens: input + (input === 100 ? 1 : input === 120 ? 2 : 3),
                  },
                },
              },
            }
          : runner === 'pi'
            ? {
                type: 'message',
                id,
                timestamp: at(offset),
                message: {
                  role: 'assistant',
                  model: 'fixture',
                  usage: { input, output: 1, cost: { total: 0.1 } },
                },
              }
            : {
                type: 'assistant',
                sessionId: request.runnerSessionId,
                timestamp: at(offset),
                message: {
                  id,
                  model: 'claude-opus-5-5',
                  usage: { input_tokens: input, output_tokens: 1 },
                },
              };
      request.sessionPath = path.join(f.root, 'skew.jsonl');
      await writeFile(
        request.sessionPath,
        [
          ...(runner === 'codex'
            ? [{ type: 'session_meta', payload: { id: request.runnerSessionId } }]
            : runner === 'pi'
              ? [{ type: 'session', id: request.runnerSessionId }]
              : []),
          message('prior', -1, 100),
          message('warm', 1, runner === 'codex' ? 120 : 20),
          message('final', 9999, runner === 'codex' ? 125 : 5),
          message('next', 10000, 300),
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n',
      );
      request.usageWindow = {
        startedAt: '2026-01-02T00:00:00Z',
        completedAt: '2026-01-02T00:00:10Z',
        nativeLeaseIds: ['warm'],
      };
      const [row] = await f.run([request]);
      assert.ok('output' in row && typeof row.output === 'string', JSON.stringify(row));
      assert.match(row.output, /input_tokens=25\noutput_tokens=2\n/);
      request.usageWindow.nativeLeaseIds = ['unknown-lease'];
      const [missing] = await f.run([request]);
      assert.ok('error' in missing);
      assert.match(String(missing.error), /no submitted command/);
    });
  }

test('bounded remote receipts keep Perps rows or return the complete parent receipt', async (t) => {
  const f = await fixture(t);
  const budget = 64 * 1024;
  const at = (second: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, second)).toISOString();
  const children = Array.from({ length: 41 }, (_, index) => ({
    stepNumber: index < 28 ? 1 : 2,
    label: `${index < 28 ? 'perps-shared' : 'perps-core'} rule ${index + 1}`,
    checkedAt: at(index + 1),
  }));
  const parents = [
    { stepNumber: 1, label: 'Shared review', checkedAt: at(28) },
    { stepNumber: 2, label: 'Core review', checkedAt: at(41) },
  ];
  const largeMix = Array.from(
    { length: 30 },
    (_, index) => `mcp__review_workspace__inspect_checklist_rule_result_${index + 1}`,
  );
  const sessionPath = path.join(f.root, 'receipt.jsonl');
  const writeReceipt = async (mixed: boolean) => {
    const tools = children.flatMap((mark, index) =>
      (mixed ? largeMix : index < 26 ? ['shell', 'read_file'] : ['shell']).map((name) => ({
        type: 'response_item',
        timestamp: mark.checkedAt,
        payload: { type: 'function_call', name, call_id: `${index}-${name}` },
      })),
    );
    await writeFile(
      sessionPath,
      [
        { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5.5' } },
        ...tools,
        {
          type: 'event_msg',
          timestamp: at(42),
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 100, output_tokens: 21, total_tokens: 121 },
            },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    return tools.length;
  };
  const runForced = async (
    marks: typeof children,
    maxBuffer: number,
    bounded = false,
    parentChecklistMarks = parents,
  ) => {
    const argv = forcedSessionUsageArgv(
      'receipt',
      'codex',
      sessionPath,
      modulePath,
      marks,
      bounded ? { maxBytes: budget, parentChecklistMarks } : undefined,
    );
    const result = await execute(process.execPath, argv.slice(1), {
      encoding: 'utf8',
      maxBuffer,
      env: { ...process.env, HOME: f.root },
    });
    return result.stdout;
  };
  const usage = (stdout: string) =>
    parseSessionUsageOutput(stdout, {
      runner: 'codex',
      runnerSessionId: 'receipt',
      runnerSessionPath: sessionPath,
    });

  assert.equal(await writeReceipt(false), 67);
  const normal = await runForced(children, budget, true);
  assert.equal(Buffer.byteLength(normal) <= budget, true);
  const normalUsage = usage(normal);
  const normalTools = normalUsage.toolUsage;
  assert(normalTools);
  assert.equal(normalTools.toolCalls, 67);
  assert.equal(normalTools.steps.filter((step) => step.title?.startsWith('perps-')).length, 41);
  assert.equal(normalUsage.totalTokens, 121);

  const largeToolCount = await writeReceipt(true);
  const largeChildren = children.map((mark, index) =>
    index === 0 ? { ...mark, label: mark.label + '\u2028Unicode separator' } : mark,
  );
  const unrestricted = await runForced(largeChildren, 2 * budget);
  assert.ok(Buffer.byteLength(unrestricted) > budget);
  const fallback = await runForced(parents, budget);
  const bounded = await runForced(largeChildren, budget, true);
  assert.equal(bounded, fallback);
  const boundedUsage = usage(bounded);
  const boundedTools = boundedUsage.toolUsage;
  assert(boundedTools);
  assert.equal(boundedTools.toolCalls, largeToolCount);
  assert.deepEqual(boundedTools.toolCallsByName, usage(unrestricted).toolUsage?.toolCallsByName);
  assert.deepEqual(
    boundedTools.steps.flatMap((step) => (step.title ? [step.title] : [])),
    parents.map((mark) => mark.label),
  );
  assert.equal(boundedUsage.totalTokens, 121);
  assert.equal(boundedUsage.runnerSessionId, 'receipt');
  assert.equal(boundedUsage.runnerSessionPath, sessionPath);
  // A child-only boundary after the final parent mark cannot prove the
  // parent's trailing timing. Keep the complete totals without inventing it.
  const ambiguous = usage(await runForced(largeChildren, budget, true, [parents[0]!]));
  assert.equal(ambiguous.totalTokens, 121);
  assert.equal(ambiguous.toolUsage?.toolCalls, largeToolCount);
  assert.deepEqual(ambiguous.toolUsage?.toolCallsByName, boundedTools.toolCallsByName);
  assert.deepEqual(ambiguous.toolUsage?.steps, []);
  assert.match(ambiguous.toolUsage?.stepsUnavailable ?? '', /exceeds the remote receipt limit/);
  t.diagnostic(
    `bytes normal=${Buffer.byteLength(normal)} expanded=${Buffer.byteLength(unrestricted)} fallback=${Buffer.byteLength(bounded)} limit=${budget}; tools normal=67 fallback=${largeToolCount}; tokens=121`,
  );
});

test('a bounded receipt leaves no Node warning bytes in the daemon output budget', async (t) => {
  const f = await fixture(t);
  const budget = 64 * 1024;
  const warning = path.join(f.root, 'startup-warning.cjs');
  const accounting = path.join(f.root, 'near-boundary.mjs');
  await writeFile(
    warning,
    "process.emitWarning('test Node startup warning', 'ExperimentalWarning');",
  );
  await writeFile(
    accounting,
    `export function runSessionUsage() { return 'turns=1\\n' + ' '.repeat(${budget - 16}); }`,
  );
  const argv = forcedSessionUsageArgv('slot', 'codex', '/receipt.jsonl', accounting, [], {
    maxBytes: budget,
    parentChecklistMarks: [],
  });
  const result = await execute(process.execPath, argv.slice(1), {
    encoding: 'utf8',
    maxBuffer: budget,
    env: { ...process.env, NODE_OPTIONS: `--require ${warning}` },
  });
  assert.match(result.stdout, /^turns=1/);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= budget);
  assert.equal(result.stderr, '');
});
