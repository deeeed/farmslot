#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAgentDeviceClient } from 'agent-device';

import { Methods, type NativeSessionInfo, type NativeSessionReadResult } from '@farmslot/protocol';

import { GatewayClient } from '../../../../packages/cli/src/gateway-client.js';

const phase = process.argv[2];
const stateFile = process.env.NATIVE_COMPANION_PROOF_STATE;
const tokenFile = process.env.NATIVE_COMPANION_TOKEN_FILE;
const url = process.env.NATIVE_COMPANION_GATEWAY;
assert(
  stateFile && tokenFile && url,
  'Set NATIVE_COMPANION_PROOF_STATE, NATIVE_COMPANION_TOKEN_FILE, NATIVE_COMPANION_GATEWAY',
);
const client = new GatewayClient({
  url,
  timeout: 30_000,
  credential: { token: readFileSync(tokenFile, 'utf8').trim() },
});
const connection = await client.connect();
type State = {
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
  fixture: string;
  token: string;
  commandId: string;
  requestId?: string;
  evidence: string;
};
let state: State;
const save = () => writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const read = () =>
  connection.call<NativeSessionReadResult>(Methods.NATIVE_SESSION_READ, {
    sessionId: state.sessionId,
    limit: 500,
  });
const wait = async (test: (page: NativeSessionReadResult) => boolean, label: string) => {
  const timeout = Number(process.env.NATIVE_COMPANION_PROOF_TIMEOUT_MS ?? 180_000);
  assert(Number.isSafeInteger(timeout) && timeout > 0);
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const page = await read();
    if (test(page)) return page;
    assert(
      !['closed', 'failed'].includes(page.session.state),
      `Session ${page.session.state} while waiting for ${label}`,
    );
    await delay(1000);
  }
  throw new Error(`Timeout waiting for ${label}`);
};
const send = async (text: string) => {
  state.commandId = `mobile-proof-${randomUUID()}`;
  save();
  await connection.call(Methods.NATIVE_SESSION_SEND, {
    sessionId: state.sessionId,
    commandId: state.commandId,
    text,
  });
};
const evidence = (label: string, page: NativeSessionReadResult) => {
  mkdirSync(state.evidence, { recursive: true });
  writeFileSync(join(state.evidence, `${label}.json`), `${JSON.stringify(page, null, 2)}\n`);
};
try {
  if (phase === 'setup' || phase === 'setup-question') {
    assert(!existsSync(stateFile), 'Use a new proof state path; do not overwrite a live session');
    const fixture = mkdtempSync(join(tmpdir(), 'farmslot-companion-native-'));
    const cwd = join(fixture, 'repo');
    mkdirSync(cwd);
    execFileSync('git', ['init', '--quiet', cwd]);
    const { session } = await connection.call<{ session: NativeSessionInfo }>(
      Methods.NATIVE_SESSION_CREATE,
      {
        runner: process.env.NATIVE_COMPANION_RUNNER ?? 'codex',
        cwd,
        model: process.env.NATIVE_COMPANION_MODEL ?? 'gpt-6-astra',
      },
    );
    assert(session.capabilities.approvals && session.capabilities.interrupt);
    if (phase === 'setup-question') assert(session.capabilities.questions);
    state = {
      fixture,
      cwd,
      sessionId: session.id,
      nativeSessionId: session.nativeSessionId,
      token: randomUUID(),
      commandId: '',
      evidence: resolve(`${stateFile}.evidence`),
    };
    save();
  } else state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;

  if (phase === 'setup' || phase === 'prepare-denial') {
    const decision = phase === 'setup' ? 'approve' : 'deny';
    const target = join(state.fixture, `${decision}.txt`);
    const code = `require('fs').writeFileSync(${JSON.stringify(target)}, 'mobile-approved')`;
    await send(
      `Remember the token ${state.token}. Run this exact Node command once using your shell tool: node -e ${JSON.stringify(code)}. This only writes a disposable validation file outside the workspace. Ask for permission when required. If permission is denied, stop and acknowledge the denial. Do not use another command, tool or retry.`,
    );
    const page = await wait(
      (value) => value.pendingRequests.some((request) => request.commandId === state.commandId),
      'approval',
    );
    const pending = page.pendingRequests.find((request) => request.commandId === state.commandId)!;
    assert.equal(pending.type, 'approval.requested');
    assert(JSON.stringify(pending).includes(target), 'Only approve the disposable proof path');
    state.requestId = pending.request!.id;
    save();
    evidence(`${decision}-pending`, page);
  } else if (phase === 'setup-question') {
    await send(
      'Use AskUserQuestion to ask exactly one question: Which folder should I use? Offer exactly two suggestions: Blue folder and Green folder. Wait for the answer, then repeat the answer exactly. Do not use other tools or change any files.',
    );
    const page = await wait(
      (value) => value.pendingRequests.some((request) => request.type === 'question.requested'),
      'question with suggested answers',
    );
    const pending = page.pendingRequests.find((request) => request.type === 'question.requested')!;
    assert.equal(pending.request?.questions?.length, 1);
    assert(pending.request.questions[0].options.length > 0);
    state.requestId = pending.request.id;
    save();
    evidence('question-pending', page);
  } else if (phase === 'approval-disclosure') {
    const page = await read();
    const pending = page.pendingRequests.find((request) => request.request?.id === state.requestId);
    assert(pending?.data, 'This proof requires structured native approval data');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const active = (await device.sessions.list()).find(
      (session) => session.device.id === process.env.IOS_SIMULATOR,
    );
    assert(active, 'The recipe must own the private simulator before inspecting approval details');
    const observed = await device.capture.snapshot({
      session: active.name,
      platform: 'ios',
      udid: process.env.IOS_SIMULATOR,
      interactiveOnly: false,
      forceFull: true,
    });
    assert(
      observed.nodes.some(
        (node) =>
          node.identifier === 'companion-native-identity' && node.label?.includes(state.sessionId),
      ),
    );
    assert(
      observed.nodes.some(
        (node) => node.identifier === `companion-native-request-${state.requestId}`,
      ),
    );
    assert(
      observed.nodes.some(
        (node) =>
          node.identifier === 'companion-native-approval-details' &&
          node.label === JSON.stringify(pending.data, null, 2),
      ),
      'Companion must disclose all structured data for the exact pending approval',
    );
    evidence(phase, page);
  } else if (phase === 'answered') {
    const page = await wait(
      (value) =>
        value.events.some(
          (event) => event.type === 'turn.completed' && event.commandId === state.commandId,
        ),
      'custom answer received by the runner',
    );
    assert(
      page.events.some(
        (event) => event.type === 'approval.resolved' && event.request?.id === state.requestId,
      ),
    );
    const text = page.events
      .filter((event) => event.commandId === state.commandId && event.type === 'text.delta')
      .map((event) => event.text)
      .join('');
    assert(
      text.includes('Use the amber folder instead'),
      'Runner did not receive the custom answer',
    );
    evidence(phase, page);
  } else if (phase === 'open') {
    assert(process.env.IOS_SIMULATOR, 'Set the private IOS_SIMULATOR');
    execFileSync('xcrun', [
      'simctl',
      'openurl',
      process.env.IOS_SIMULATOR,
      `farmslot-development:///native?sessionId=${encodeURIComponent(state.sessionId)}&executionNodeId=local`,
    ]);
  } else if (phase === 'approved' || phase === 'denied') {
    const page = await wait(
      (value) =>
        value.events.some(
          (event) => event.type === 'turn.completed' && event.commandId === state.commandId,
        ),
      'turn completion',
    );
    assert.equal(page.session.id, state.sessionId);
    assert.equal(page.session.nativeSessionId, state.nativeSessionId);
    assert(
      page.events.some(
        (event) => event.type === 'approval.resolved' && event.request?.id === state.requestId,
      ),
    );
    if (phase === 'approved')
      assert.equal(readFileSync(join(state.fixture, 'approve.txt'), 'utf8'), 'mobile-approved');
    else
      assert.equal(
        existsSync(join(state.fixture, 'deny.txt')),
        false,
        'Denied tool must not execute',
      );
    evidence(phase, page);
  } else if (phase === 'continued') {
    const page = await wait(
      (value) =>
        value.commands.some(
          (command) =>
            command.commandId.startsWith('mobile-') &&
            !command.commandId.startsWith('mobile-proof-') &&
            command.state === 'completed',
        ),
      'mobile continuation',
    );
    const command = page.commands.find(
      (value) =>
        value.commandId.startsWith('mobile-') &&
        !value.commandId.startsWith('mobile-proof-') &&
        value.state === 'completed',
    )!;
    assert.equal(page.session.nativeSessionId, state.nativeSessionId);
    const text = page.events
      .filter((event) => event.commandId === command.commandId && event.type === 'text.delta')
      .map((event) => event.text)
      .join('');
    assert(
      text.includes(state.token),
      'Mobile follow-up must retain the exact prior session token',
    );
    assert.equal(
      page.events.filter(
        (event) => event.commandId === command.commandId && event.type === 'command.submitted',
      ).length,
      1,
      'Continuation delivered once',
    );
    evidence(phase, page);
  } else if (phase === 'prepare-interrupt') {
    await send(
      'Use the shell tool to run exactly: sleep 120. After it ends reply done. This is a disposable cancellation proof.',
    );
    const page = await wait(
      (value) =>
        value.events.some(
          (event) => event.commandId === state.commandId && event.type === 'tool.started',
        ),
      'sleep tool',
    );
    evidence(phase, page);
  } else if (phase === 'interrupted') {
    const page = await wait(
      (value) =>
        value.events.some(
          (event) =>
            event.commandId === state.commandId &&
            event.type === 'turn.completed' &&
            event.status === 'interrupted',
        ),
      'mobile interruption',
    );
    evidence(phase, page);
  } else if (phase === 'cleanup') {
    await connection.call(Methods.NATIVE_SESSION_CLOSE, { sessionId: state.sessionId });
    const page = await read();
    assert.equal(page.session.state, 'closed');
    assert.equal(page.session.processStopped, true);
    evidence(phase, page);
  } else if (phase !== 'setup' && phase !== 'prepare-denial')
    throw new Error(`Unknown proof phase ${phase}`);
  console.log(
    JSON.stringify({ phase, sessionId: state.sessionId, evidence: state.evidence, pass: true }),
  );
} finally {
  connection.close();
}
