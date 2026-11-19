import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  antigravityNativeAdapter,
  configureAntigravityModel,
  observeAntigravityAccount,
} from './antigravity.js';
import type { NativeEventInput } from './types.js';

const agyFixture = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('1.5.12');
  process.exit(0);
}
const fs = require('node:fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
const signedOut = process.env.AGY_FIXTURE_SIGNED_OUT === '1';
const mismatch = process.env.AGY_FIXTURE_MISMATCH === '1';
const availableModels = [
  { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];
let configOptions = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  {
    id: 'thought_level',
    category: 'thought_level',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];
let sessionId = 'agy-session-1';
let activePromptId;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } });

require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      },
    });
  }
  if (m.method === 'session/list') {
    if (signedOut) {
      return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    }
    return send({ id: m.id, result: { sessions: [] } });
  }
  if (m.method === 'session/new' || m.method === 'session/load') {
    if (signedOut) {
      return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    }
    if (m.method === 'session/load') {
      sessionId = m.params.sessionId;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY' } });
    }
    return send({
      id: m.id,
      result: {
        ...(m.method === 'session/new' ? { sessionId } : {}),
        models: { availableModels, currentModelId: 'gemini-4-neon-high' },
        modes: {
          currentModeId: 'default',
          availableModes: [{ id: 'default' }, { id: 'accept-edits' }, { id: 'auto' }, { id: 'plan' }],
        },
        configOptions,
      },
    });
  }
  if (m.method === 'session/set_mode') {
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/set_config_option') {
    const val = m.params.value;
    if (val === 'gemini-3.8-flash-low') {
      configOptions[0].currentValue = mismatch ? 'gemini-4-neon' : 'gemini-3.8-flash';
      configOptions[1].currentValue = mismatch ? 'high' : 'low';
      return send({ id: m.id, result: { configOptions } });
    }
    if (val === 'gpt-oss-120b-medium') {
      configOptions[0].currentValue = 'gpt-oss-120b-medium';
      return send({ id: m.id, result: { configOptions } });
    }
    return send({ id: m.id, error: { code: -32602, message: 'Unknown model ID: ' + val } });
  }
  if (m.method === 'session/prompt') {
    activePromptId = m.id;
    const text = m.params.prompt[0].text;
    if (text === 'permission') {
      return send({
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'call-1',
            title: 'Write file',
            kind: 'edit',
            rawInput: { Path: '/tmp/a.txt', Content: 'hello' },
            content: [{ type: 'diff', path: '/tmp/a.txt', newText: 'hello' }],
          },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    }
    if (text === 'slow') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STREAMING' } });
      return;
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK:' + text } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.method === 'session/cancel' && activePromptId !== undefined) {
    const id = activePromptId;
    activePromptId = undefined;
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  if (m.id === 'perm-1' && !m.method) {
    fs.writeFileSync('perm-response.json', JSON.stringify(m.result));
    return send({ id: activePromptId, result: { stopReason: 'end_turn' } });
  }
});
`;

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Antigravity fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setupFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'farmslot-agy-test-'));
  const executable = join(cwd, 'agy');
  writeFileSync(executable, agyFixture);
  chmodSync(executable, 0o700);
  return { cwd, executable, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('configureAntigravityModel confirms concrete model+thought IDs and refuses unavailable models', async () => {
  const session = {
    models: {
      availableModels: [
        { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
        { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
        { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    },
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: 'gemini-4-neon',
        options: [
          { value: 'gemini-4-neon' },
          { value: 'gemini-3.8-flash' },
          { value: 'gpt-oss-120b-medium' },
        ],
      },
      { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [] },
    ],
  };

  let sent = 0;
  const confirmed = await configureAntigravityModel(
    's1',
    session,
    'gemini-3.8-flash-low',
    async () => {
      sent++;
      return {
        configOptions: [
          { id: 'model', currentValue: 'gemini-3.8-flash' },
          { id: 'thought_level', currentValue: 'low' },
        ],
      };
    },
  );
  assert.equal(confirmed, 'gemini-3.8-flash-low');
  assert.equal(sent, 1);

  const exact = await configureAntigravityModel('s1', session, 'gpt-oss-120b-medium', async () => ({
    configOptions: [{ id: 'model', currentValue: 'gpt-oss-120b-medium' }],
  }));
  assert.equal(exact, 'gpt-oss-120b-medium');

  let rejectedSent = 0;
  await assert.rejects(
    configureAntigravityModel('s1', session, 'gemini-nonexistent-99', async () => {
      rejectedSent++;
      return {};
    }),
    /not available for the selected account/,
  );
  assert.equal(rejectedSent, 0);

  await assert.rejects(
    configureAntigravityModel('s1', session, 'gemini-3.8-flash-low', async () => ({
      configOptions: [
        { id: 'model', currentValue: 'gemini-4-neon' },
        { id: 'thought_level', currentValue: 'high' },
      ],
    })),
    /did not confirm model/,
  );
});

test('antigravityNativeAdapter confirms model, enforces permissions, cancels, and resumes', async () => {
  const fixture = setupFixture();
  try {
    const events: NativeEventInput[] = [];
    const session = await antigravityNativeAdapter.start(
      {
        cwd: fixture.cwd,
        executable: fixture.executable,
        model: 'gemini-3.8-flash-low',
        mode: 'default',
        approvalMode: 'ask',
      },
      (event) => events.push(event),
    );
    try {
      assert.equal(session.nativeSessionId, 'agy-session-1');
      assert.equal(session.model, 'gemini-3.8-flash-low');
      assert.deepEqual(session.capabilities?.modes, ['default', 'plan']);
      assert.deepEqual(session.capabilities?.approvalModes, ['ask', 'bypass']);
      assert.equal(session.capabilities?.questions, false);
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.cwd, 'argv.json'), 'utf8')), ['acp']);
      assert.equal(
        events.find((e) => e.type === 'session.started')?.data?.model,
        'gemini-3.8-flash-low',
      );

      // Ask permission flow -> approve
      await session.send('permission', 'cmd-perm');
      await until(() => events.some((e) => e.type === 'approval.requested'));
      const reqId = events.find((e) => e.type === 'approval.requested')!.request!.id;
      await session.respond(reqId, { decision: 'approve' });
      await until(() =>
        events.some((e) => e.type === 'turn.completed' && e.commandId === 'cmd-perm'),
      );
      assert.deepEqual(JSON.parse(readFileSync(join(fixture.cwd, 'perm-response.json'), 'utf8')), {
        outcome: { outcome: 'selected', optionId: 'allow' },
      });

      // Bypass mode -> automatic audited grant without approval.requested
      await session.setApprovalMode!('bypass');
      const beforeBypass = events.length;
      await session.send('permission', 'cmd-bypass');
      await until(() =>
        events
          .slice(beforeBypass)
          .some((e) => e.type === 'turn.completed' && e.commandId === 'cmd-bypass'),
      );
      const bypassEvents = events.slice(beforeBypass);
      assert.equal(
        bypassEvents.some((e) => e.type === 'approval.requested'),
        false,
      );
      assert.equal(
        bypassEvents.some(
          (e) =>
            e.type === 'approval.resolved' &&
            e.data?.automatic === true &&
            e.data?.approvalMode === 'bypass',
        ),
        true,
      );

      // Interrupt / cancel
      await session.send('slow', 'cmd-cancel');
      await until(() => events.some((e) => e.type === 'text.delta' && e.text === 'STREAMING'));
      await session.interrupt();
      await until(() =>
        events.some(
          (e) =>
            e.type === 'turn.completed' &&
            e.commandId === 'cmd-cancel' &&
            e.status === 'interrupted',
        ),
      );
    } finally {
      await session.close();
    }

    // Resume exact session ID
    const resumedEvents: NativeEventInput[] = [];
    const resumed = await antigravityNativeAdapter.start(
      {
        cwd: fixture.cwd,
        executable: fixture.executable,
        model: 'gemini-3.8-flash-low',
        resumeSessionId: 'agy-session-1',
      },
      (event) => resumedEvents.push(event),
    );
    try {
      assert.equal(resumed.nativeSessionId, 'agy-session-1');
      assert.equal(
        resumedEvents.some((e) => e.text === 'REPLAY'),
        false,
      );
    } finally {
      await resumed.close();
    }

    // Reject unavailable model without falling back to default
    await assert.rejects(
      antigravityNativeAdapter.start(
        {
          cwd: fixture.cwd,
          executable: fixture.executable,
          model: 'gemini-unavailable',
        },
        () => {},
      ),
      /not available for the selected account/,
    );

    // Reject separate effort parameter
    await assert.rejects(
      antigravityNativeAdapter.start(
        {
          cwd: fixture.cwd,
          executable: fixture.executable,
          model: 'gemini-3.8-flash-low',
          effort: 'high',
        },
        () => {},
      ),
      /effort must be selected through the model ID/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('observeAntigravityAccount distinguishes missing binary, signed-out, and authenticated states', async () => {
  const fixture = setupFixture();
  try {
    const missing = await observeAntigravityAccount({
      cwd: fixture.cwd,
      executable: join(fixture.cwd, 'missing-agy'),
      env: { PATH: '' },
    });
    assert.equal(missing.installed, false);
    assert.equal(missing.login, 'unavailable');
    assert.equal(missing.reason, 'not-installed');

    const signedOut = await observeAntigravityAccount({
      cwd: fixture.cwd,
      executable: fixture.executable,
      env: { ...process.env, AGY_FIXTURE_SIGNED_OUT: '1' },
    });
    assert.equal(signedOut.installed, true);
    assert.equal(signedOut.version, '1.5.12');
    assert.equal(signedOut.login, 'signed-out');

    const ok = await observeAntigravityAccount({
      cwd: fixture.cwd,
      executable: fixture.executable,
      env: { ...process.env, AGY_FIXTURE_SIGNED_OUT: '0' },
    });
    assert.equal(ok.installed, true);
    assert.equal(ok.version, '1.5.12');
    assert.equal(ok.login, 'authenticated');
  } finally {
    fixture.cleanup();
  }
});
