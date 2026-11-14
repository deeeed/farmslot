import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { observeOpenCodeAccount } from './account-opencode.js';
import { fixture, setup, until } from './acp.test-support.js';
import { cursorNativeAdapter } from './cursor.js';
import { grokNativeAdapter } from './grok.js';
import { opencodeNativeAdapter } from './opencode.js';
import type { NativeEventInput } from './types.js';

test('an autonomous Grok run starts without its question tool', async () => {
  for (const modelQuestions of ['off', undefined] as const) {
    const f = setup();
    writeFileSync(
      f.executable,
      fixture.replace(
        "const fs=require('node:fs');",
        "const fs=require('node:fs');fs.writeFileSync('grok-question',String(process.env.GROK_ASK_USER_QUESTION));",
      ),
    );
    const session = await grokNativeAdapter.start({ ...f, modelQuestions }, () => undefined);
    try {
      assert.equal(
        readFileSync(join(f.cwd, 'grok-question'), 'utf8'),
        modelQuestions ? '0' : 'undefined',
      );
    } finally {
      await session.close();
      f.cleanup();
    }
  }
});

test('the OpenCode permission override reaches the runner process', async () => {
  const f = setup();
  const session = await opencodeNativeAdapter.start(
    { ...f, safetyTier: 'sandboxed' },
    () => undefined,
  );
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, 'opencode-permission'), 'utf8')), {
      '*': 'ask',
    });
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('OpenCode account observation signs in over ACP', async () => {
  const f = setup();
  try {
    const observed = await observeOpenCodeAccount({ cwd: f.cwd, executable: f.executable });
    assert.deepEqual([observed.installed, observed.login], [true, 'authenticated']);
  } finally {
    f.cleanup();
  }
});

test('OpenCode refuses a model it does not offer', async () => {
  const f = setup();
  try {
    await assert.rejects(
      opencodeNativeAdapter.start({ ...f, model: 'other/model' }, () => undefined),
      /OpenCode model is unavailable: other\/model/,
    );
  } finally {
    f.cleanup();
  }
});

test('a Cursor shell call keeps its kind when an update adds the command', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await cursorNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('shell', 'c1');
    await until(() => events.some((e) => e.type === 'turn.completed'));
    const tool = events.find((e) => e.type === 'tool.completed')?.tool;
    assert.deepEqual(
      [tool?.kind, tool?.command, tool?.output],
      ['command', 'npm test', { exitCode: 0, stdout: 'ok\n', stderr: '' }],
    );
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('an ACP plan update is the whole checklist, without its priorities', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await grokNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('plan', 'c1');
    await until(() => events.some((e) => e.type === 'turn.completed'));
    const plans = events.filter((e) => e.type === 'plan.updated');
    assert.deepEqual(
      plans.map((e) => [e.commandId, e.plan]),
      [
        [
          'c1',
          {
            kind: 'checklist',
            steps: [
              { text: 'Inspect', status: 'in-progress' },
              { text: 'Report', status: 'pending' },
            ],
          },
        ],
        [
          'c1',
          {
            kind: 'checklist',
            steps: [
              { text: 'Inspect', status: 'completed' },
              { text: 'Report', status: 'completed' },
            ],
          },
        ],
      ],
    );
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('ACP permission ownership, one-time denial and unsupported host operations', async () => {
  const f = setup();
  const events: NativeEventInput[] = [];
  const session = await cursorNativeAdapter.start(f, (event) => events.push(event));
  try {
    await session.send('permission', 'c1');
    await until(() => events.some((e) => e.type === 'approval.requested'));
    await assert.rejects(session.respond('foreign', { decision: 'approve' }), /stale/);
    const request = events.find((e) => e.type === 'approval.requested')!;
    await session.respond(request.nativeId!, { decision: 'deny' });
    await until(() => events.some((e) => e.type === 'turn.completed'));
    assert.equal(
      JSON.parse(readFileSync(join(f.cwd, 'permission'), 'utf8')).outcome.optionId,
      'deny-once',
    );
    await assert.rejects(session.respond(request.nativeId!, { decision: 'approve' }), /stale/);
    await session.send('unknown', 'c2');
    await until(() => events.filter((e) => e.type === 'turn.completed').length === 2);
    assert.equal(JSON.parse(readFileSync(join(f.cwd, 'unsupported'), 'utf8')).code, -32601);
    await session.send('error', 'c3');
    await until(() => events.filter((e) => e.type === 'turn.completed').length === 3);
    assert.equal(
      events.find((e) => e.type === 'command.accepted' && e.commandId === 'c3'),
      undefined,
    );
    assert.equal(events.at(-1)?.status, 'failed');
  } finally {
    await session.close();
    f.cleanup();
  }
});
