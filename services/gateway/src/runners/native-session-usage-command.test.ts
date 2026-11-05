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

import {
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
