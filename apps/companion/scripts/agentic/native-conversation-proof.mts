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
  /** The finished-turn fold row's label without its open/closed marker, once fold-state read it. */
  foldLabel?: string;
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
    const runner = process.env.NATIVE_COMPANION_RUNNER ?? 'codex';
    const { session } = await connection.call<{ session: NativeSessionInfo }>(
      Methods.NATIVE_SESSION_CREATE,
      {
        runner,
        cwd,
        model: process.env.NATIVE_COMPANION_MODEL ?? 'gpt-6-astra',
        // Codex asks the operator questions only in plan mode; its session advertises that.
        ...(phase === 'setup-question' && runner === 'codex' ? { mode: 'plan' } : {}),
      },
    );
    if (phase === 'setup-question')
      assert.equal(
        session.capabilities.questions,
        true,
        `The ${runner} session must advertise questions before the question proof`,
      );
    assert(session.capabilities.approvals && session.capabilities.interrupt);
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
  } else if (phase === 'approval-disclosure' || phase === 'replayed-disclosure') {
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
    if (phase === 'replayed-disclosure') {
      // After the reload and the reopened link: the same native request, with the same details the
      // pre-reload capture recorded, is what the device shows again.
      const before = JSON.parse(
        readFileSync(join(state.evidence, 'approval-disclosure.json'), 'utf8'),
      ) as NativeSessionReadResult;
      const captured = before.pendingRequests.find(
        (request) => request.request?.id === state.requestId,
      );
      assert(captured, 'The pre-reload capture must hold the pending approval');
      assert.equal(pending.request?.id, captured.request?.id);
      assert.deepEqual(pending.data, captured.data, 'Replayed approval details changed');
    }
    evidence(phase, page);
  } else if (phase === 'reveal') {
    // `reveal <test id>`: the row is above the viewport by however much the real model wrote (the
    // conversation follows its end, and an opened fold keeps the reader's place while its tools
    // render above it). Drag back through the transcript in short steps until the row is on
    // screen, rather than by a fixed distance.
    const wanted = process.argv[3];
    assert(wanted, 'reveal needs a test id');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const active = (await device.sessions.list()).find(
      (session) => session.device.id === process.env.IOS_SIMULATOR,
    );
    assert(active, 'The recipe must own the private simulator before revealing a row');
    const target = {
      session: active.name,
      platform: 'ios' as const,
      udid: process.env.IOS_SIMULATOR,
    };
    let steps = 0;
    for (;;) {
      const observed = await device.capture.snapshot({ ...target, interactiveOnly: false });
      const transcript = observed.nodes.find(
        (node) => node.identifier === 'companion-native-transcript',
      );
      const row = observed.nodes.find((node) => node.identifier === wanted);
      assert(transcript?.rect, 'The transcript is not on screen');
      const top = transcript.rect.y;
      const bottom = transcript.rect.y + transcript.rect.height;
      if (row?.rect && row.rect.y >= top && row.rect.y + row.rect.height <= bottom) break;
      assert(steps < 12, `No ${wanted} on screen after ${steps} drags`);
      const x = transcript.rect.x + transcript.rect.width / 2;
      await device.interactions.swipe({
        ...target,
        from: { x, y: top + transcript.rect.height * 0.3 },
        to: { x, y: top + transcript.rect.height * 0.7 },
        durationMs: 300,
      });
      steps += 1;
      await delay(600);
    }
    console.log(JSON.stringify({ phase, wanted, steps }));
  } else if (phase === 'fold-state') {
    // `fold-state <open|closed>`: the finished-turn fold row on screen shows that state. The first
    // read records which fold it is; later reads must find that same fold, so a toggle that did
    // nothing, or a different row, fails.
    const expected = process.argv[3];
    assert(expected === 'open' || expected === 'closed', 'fold-state needs open or closed');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const active = (await device.sessions.list()).find(
      (session) => session.device.id === process.env.IOS_SIMULATOR,
    );
    assert(active, 'The recipe must own the private simulator before reading the fold');
    const observed = await device.capture.snapshot({
      session: active.name,
      platform: 'ios',
      udid: process.env.IOS_SIMULATOR,
      interactiveOnly: false,
    });
    // NativeWorkCard labels the row "▾ Worked for … · N tools" when open and "▸ …" when closed.
    const folds = observed.nodes
      .filter((node) => node.identifier === 'companion-native-work-fold' && node.label)
      .map((node) => ({
        marker: node.label!.trim().charAt(0),
        rest: node.label!.trim().slice(1).trim(),
      }));
    const fold = state.foldLabel
      ? folds.find((entry) => entry.rest === state.foldLabel)
      : folds.length === 1
        ? folds[0]
        : undefined;
    assert(fold, `Expected one finished-turn fold row on screen: ${JSON.stringify(folds)}`);
    assert.equal(fold.marker, expected === 'open' ? '\u25be' : '\u25b8', `Fold is not ${expected}`);
    state.foldLabel = fold.rest;
    save();
    console.log(JSON.stringify({ phase, state: expected, fold: fold.rest }));
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
    const streamInterrupt = process.env.NATIVE_COMPANION_INTERRUPT_MODE === 'stream';
    await send(
      streamInterrupt
        ? 'Write a comprehensive 3000-word treatise explaining the history of distributed consensus algorithms with full examples. Do not use any tools.'
        : 'Use the shell tool to run exactly: sleep 120. After it ends reply done. This is a disposable cancellation proof.',
    );
    const expectedEvent = streamInterrupt ? 'text.delta' : 'tool.started';
    const page = await wait(
      (value) =>
        value.events.some(
          (event) => event.commandId === state.commandId && event.type === expectedEvent,
        ),
      streamInterrupt ? 'streaming turn to interrupt' : 'sleep tool',
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
