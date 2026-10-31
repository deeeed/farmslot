import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Methods,
  type NativeSessionEvent,
  type NativeSessionInfo,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

import { NativeCheckpoints } from './checkpoint.js';
import { NativeSessionClient } from './client.js';
import { routeNativeSession } from './service.js';

/** A host whose only answer is this session's history, paged as `read` pages it. */
class HistoryClient extends NativeSessionClient {
  constructor(
    private readonly session: NativeSessionInfo,
    private readonly events: NativeSessionEvent[],
  ) {
    super(session.cwd, 'local');
  }
  override read(_owner: string, _id: string, after = 0, limit = 100) {
    const events = this.events.filter((event) => event.sequence > after).slice(0, limit);
    return Promise.resolve<NativeSessionReadResult>({
      session: this.session,
      events,
      cursor: events.at(-1)?.sequence ?? after,
      hasMore: false,
      commands: [],
      pendingRequests: [],
    });
  }
}

test('a turn diff is served for a file its turn.changes event lists, and nothing else', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-turn-diff-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
      cwd,
      env,
    });
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(cwd, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const checkpoints = (await NativeCheckpoints.open(cwd, 'session'))!;
    const from = await checkpoints.take();
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\n');
    const to = await checkpoints.take();
    const changes = await checkpoints.changes(from, to);
    const session: NativeSessionInfo = {
      id: 'session',
      generation: 'g',
      hostPid: 0,
      runner: 'codex',
      nativeSessionId: 'thread',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'owner',
      cwd,
      executable: 'codex',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: false,
        interrupt: true,
        resume: true,
      },
      state: 'idle',
    };
    const client = new HistoryClient(session, [
      { sessionId: 'session', generation: 'g', sequence: 1, at: '', type: 'turn.completed' },
      { sessionId: 'session', generation: 'g', sequence: 2, at: '', type: 'turn.changes', changes },
    ]);
    const diff = (params: Record<string, unknown>) =>
      routeNativeSession(client, 'owner', Methods.NATIVE_SESSION_TURN_DIFF, {
        sessionId: 'session',
        ...params,
      });
    const result = (await diff({ sequence: 2, path: 'a.txt' })) as { diff: string };
    assert.match(result.diff, /\+two/);
    await assert.rejects(diff({ sequence: 2, path: 'other.txt' }), /lists no such changed file/);
    await assert.rejects(diff({ sequence: 1, path: 'a.txt' }), /lists no such changed file/);
    await assert.rejects(diff({ sequence: 0, path: 'a.txt' }), /positive integer/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
