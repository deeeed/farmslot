import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createAcpAdapter } from './acp.js';
import { setup, until } from './acp.test-support.js';
import type { NativeEventInput } from './types.js';

test('an ACP agent with an existing login needs no advertised or interactive authentication method', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const events: NativeEventInput[] = [];
  const adapter = createAcpAdapter({
    args: () => [],
    modes: ['default', 'plan'],
    defaultModeId: 'default',
  });
  const session = await adapter.start(
    { ...f, env: { ...process.env, ACP_FIXTURE_EXISTING_LOGIN: '1' } },
    (event) => events.push(event),
  );
  try {
    assert.equal(session.nativeSessionId, 'fixture-session');
    const calls = readFileSync(join(f.cwd, 'wire'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.some((call) => call.method === 'authenticate'),
      false,
    );
    assert.equal(
      calls.find((call) => call.method === 'session/set_mode')?.params.modeId,
      'default',
    );
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('generic ACP model and effort configuration uses advertised options and confirms both choices', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const configOptions = [
    {
      id: 'provider-model',
      category: 'model',
      currentValue: 'opus',
      options: [{ value: 'opus' }, { value: 'haiku' }],
    },
    {
      id: 'thinking',
      category: 'thought_level',
      currentValue: 'high',
      options: [{ value: 'low' }, { value: 'high' }],
    },
  ];
  const adapter = createAcpAdapter({
    authMethod: 'cursor_login',
    args: () => [],
    modes: ['default', 'plan'],
    effortConfig: true,
  });
  const session = await adapter.start(
    {
      ...f,
      model: 'haiku',
      effort: 'low',
      mode: 'plan',
      env: { ...process.env, ACP_FIXTURE_CONFIG: JSON.stringify(configOptions) },
    },
    () => {},
  );
  try {
    const calls = readFileSync(join(f.cwd, 'wire'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls
        .filter((call) => call.method === 'session/set_config_option')
        .map((call) => [call.params.configId, call.params.value]),
      [
        ['provider-model', 'haiku'],
        ['thinking', 'low'],
      ],
    );
    assert.equal(
      calls.some((call) => call.method === 'session/set_model'),
      false,
    );
    assert.equal(calls.find((call) => call.method === 'session/set_mode')?.params.modeId, 'plan');
  } finally {
    await session.close();
    f.cleanup();
  }
});

test('a failed automatic-approval audit cannot grant the ACP permission', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const events: NativeEventInput[] = [];
  let auditFailed = false;
  const adapter = createAcpAdapter({ args: () => [], modes: ['default'] });
  const session = await adapter.start(
    { ...f, approvalMode: 'bypass', env: { ...process.env, ACP_FIXTURE_EXISTING_LOGIN: '1' } },
    (event) => {
      if (event.type === 'approval.resolved') {
        auditFailed = true;
        throw new Error('Private audit store unavailable');
      }
      events.push(event);
    },
  );
  try {
    await session.send('permission', 'audit-failure');
    await until(() =>
      events.some((event) => event.type === 'session.closed' || event.type === 'turn.completed'),
    );
    assert.equal(auditFailed, true);
    assert.equal(existsSync(join(f.cwd, 'permission')), false);
  } finally {
    await session.close();
  }
});

test('ACP diff content survives raw output and partial terminal tool updates', async (t) => {
  const f = setup();
  t.after(f.cleanup);
  const events: NativeEventInput[] = [];
  const adapter = createAcpAdapter({
    authMethod: 'cursor_login',
    args: () => [],
    modes: ['default'],
  });
  const session = await adapter.start(f, (event) => events.push(event));
  try {
    await session.send('file-diff', 'edit');
    await until(() => events.some((event) => event.type === 'turn.completed'));
    const tool = events.find((event) => event.type === 'tool.completed')?.tool;
    assert.deepEqual(tool?.diffs, [
      { path: '/work/example.txt', oldText: 'before\n', newText: 'after\n' },
    ]);
    assert.deepEqual(tool?.output, { written: true });
    assert.deepEqual(tool?.paths, ['/work/example.txt']);
  } finally {
    await session.close();
  }
});
