import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createAcpAdapter } from './acp.js';
import { setup, until } from './acp.test-support.js';
import { claudeAcpNativeAdapter } from './claude-acp.js';
import type { NativeEventInput } from './types.js';

test('read-only ACP reviews disable user hooks while ordinary sessions preserve user settings', async (t) => {
  for (const review of [true, false]) {
    const f = setup();
    t.after(f.cleanup);
    const session = await claudeAcpNativeAdapter.start(
      {
        ...f,
        ...(review ? { filesystemPolicy: { readOnlyRoots: [f.cwd], writableRoots: [] } } : {}),
        env: {
          ...process.env,
          ACP_FIXTURE_EXISTING_LOGIN: '1',
          CLAUDE_CODE_EXECUTABLE: f.executable,
        },
      },
      () => {},
    );
    try {
      const calls = readFileSync(join(f.cwd, 'wire'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const policy = calls.find((call) => call.method === 'session/new')?.params._meta?.claudeCode
        ?.options;
      if (review) {
        assert.deepEqual(policy?.settingSources, ['user']);
        assert.equal(policy?.settings?.disableAllHooks, true);
      } else {
        assert.equal(policy?.settingSources, undefined);
        assert.equal(policy?.settings, undefined);
      }
      assert.deepEqual(policy?.disallowedTools, ['Monitor']);
      assert.equal(readFileSync(join(f.cwd, 'claude-background'), 'utf8'), '1');
    } finally {
      await session.close();
    }
  }
});

test('ACP journals a final file diff arriving after the tool completed', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const events: NativeEventInput[] = [];
  const session = await createAcpAdapter({
    args: () => [],
    authMethod: 'cursor_login',
    modes: ['default'],
  }).start(f, (event) => events.push(event));
  try {
    await session.send('late-file-diff', 'late');
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.deepEqual(
      events.filter((event) => event.type === 'tool.completed').at(-1)?.tool?.diffs,
      [{ path: '/work/existing.txt', oldText: 'whole before\n', newText: 'whole after\n' }],
    );
  } finally {
    await session.close();
  }
});
