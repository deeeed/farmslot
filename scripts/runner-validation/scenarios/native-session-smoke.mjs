import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'native-session-smoke';

// FARMSLOT_GATEWAY=ws://127.0.0.1:18777 FARMSLOT_RPC_TIMEOUT_MS=120000 \
//   node scripts/runner-validation/run.mjs --runner codex --scenario native-session-smoke \
//   --out-dir temp/native-validation/evidence
// Select individual stages for diagnosis without spending another full live run.
// Every invocation creates its own fixture and session. No operator Copilot is touched.
const STAGES = ['core', 'approvals', 'questions', 'interrupt', 'resume'];

function rpc(method, params = {}) {
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: ROOT, encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    error.rpcMethod = method;
    error.rpcCode = String(error.stderr ?? '').match(/"code":"([A-Z_]+)"/)?.[1];
    throw error;
  }
  return JSON.parse(stdout);
}

function expectRejected(method, params) {
  try {
    rpc(method, params);
  } catch (error) {
    // Transport failure cannot prove the gateway rejected the requested operation.
    const stderr = String(error.stderr ?? '');
    assert.match(stderr, /"ok":false/, `${method} failed without a gateway error response`);
    return { method, rejected: true };
  }
  throw new Error(`${method} unexpectedly accepted the negative control`);
}

function eventEvidence(event) {
  // Avoid dumping runner envelopes, environment, account data, or tool outputs.
  return Object.fromEntries(
    ['sessionId', 'sequence', 'at', 'type', 'status', 'commandId', 'turnId', 'nativeId']
      .filter((key) => event[key] !== undefined)
      .map((key) => [key, event[key]]),
  );
}

export async function runScenario({ runnerAdapter, timeoutMs, outDir, model }) {
  const runner = runnerAdapter.RUNNER_ID;
  const stages = (process.env.FARMSLOT_NATIVE_STAGES ?? STAGES.join(',')).split(',');
  for (const stage of stages) assert.ok(STAGES.includes(stage), `Unknown native stage: ${stage}`);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `farmslot-native-${runner}-`));
  const cwd = path.join(fixture, 'repo');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '--quiet'], { cwd });
  const secret = `CONTEXT_${randomUUID().replaceAll('-', '')}`;
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), `${secret}\n`);
  const report = {
    runner,
    gateway: process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777',
    fixture,
    stages,
    billing:
      'Not measured. Native account access does not establish subscription cost or entitlement.',
    checks: [],
    sessions: [],
    events: [],
    pass: false,
    error: null,
  };
  let session;
  let latest;
  let savedSequence = 0;

  function read() {
    latest = rpc('native.session.read', { sessionId: session.id });
    assert.equal(latest.session.id, session.id);
    assert.ok(latest.cursor >= savedSequence, 'Event cursor went backwards');
    const sequences = latest.events.map((event) => event.sequence);
    assert.equal(new Set(sequences).size, sequences.length, 'Duplicate event sequence');
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
    );
    report.events.push(
      ...latest.events.filter((event) => event.sequence > savedSequence).map(eventEvidence),
    );
    savedSequence = latest.cursor;
    return latest;
  }

  async function wait(predicate, label, respond) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (respond) respond(value);
      if (predicate(value)) return value;
      assert.notEqual(value.session.state, 'failed', `Runner failed while waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  function send(text) {
    const commandId = randomUUID();
    const result = rpc('native.session.send', { sessionId: session.id, commandId, text });
    assert.equal(result.submitted, true);
    return { commandId, text };
  }

  function eventsFor(value, command) {
    return value.events.filter((event) => event.commandId === command.commandId);
  }

  async function complete(command, respond, expectedStatus = 'completed') {
    const value = await wait(
      (current) => eventsFor(current, command).some((event) => event.type === 'turn.completed'),
      'structured turn completion',
      respond,
    );
    const events = eventsFor(value, command);
    for (const type of ['command.accepted', 'turn.started', 'turn.completed']) {
      assert.ok(
        events.some((event) => event.type === type),
        `Missing ${type}`,
      );
    }
    const completed = events.find((event) => event.type === 'turn.completed');
    assert.equal(completed.status, expectedStatus, 'Unexpected terminal turn status');
    assert.ok(completed.nativeId || completed.turnId, 'Completion has no native turn identity');
    for (const type of ['command.accepted', 'turn.started']) {
      assert.ok(
        events.find((event) => event.type === type).sequence < completed.sequence,
        `${type} followed completion`,
      );
    }
    if (expectedStatus === 'completed') {
      assert.ok(
        events.some((event) => event.type === 'text.delta' && event.sequence < completed.sequence),
        'No streamed text before completion',
      );
    }
    return {
      events,
      text: events
        .filter((event) => event.type === 'text.delta')
        .map((event) => event.text ?? '')
        .join(''),
    };
  }

  function recordSession() {
    report.sessions.push({
      id: session.id,
      nativeSessionId: session.nativeSessionId,
      runner: session.runner,
      executable: session.executable,
      version: session.version,
      capabilities: session.capabilities,
    });
  }

  try {
    session = rpc('native.session.create', {
      runner,
      cwd,
      ...(model ? { model } : {}),
      ...(process.env.FARMSLOT_NATIVE_MODE ? { mode: process.env.FARMSLOT_NATIVE_MODE } : {}),
    }).session;
    recordSession();
    assert.ok(session.nativeSessionId, 'Missing native session identity');
    const first = send(
      `Remember this exact token for subsequent turns: ${secret}. Reply with that token only. Do not use tools.`,
    );
    const firstResult = await complete(first);
    assert.ok(firstResult.text.includes(secret), 'Streamed response omitted the context token');
    report.checks.push({ name: 'structured-turn-and-stream', pass: true });

    if (stages.includes('core')) {
      const duplicate = rpc('native.session.send', { sessionId: session.id, ...first });
      assert.equal(duplicate.accepted, true);
      const afterDuplicate = read();
      assert.equal(
        eventsFor(afterDuplicate, first).filter((event) => event.type === 'command.accepted')
          .length,
        1,
      );
      assert.equal(
        eventsFor(afterDuplicate, first).filter((event) => event.type === 'turn.started').length,
        1,
      );
      report.checks.push({ name: 'duplicate-command-does-not-run-again', pass: true });
      report.checks.push(
        expectRejected('native.session.send', {
          sessionId: session.id,
          commandId: first.commandId,
          text: 'Changed command must be rejected.',
        }),
      );
      report.checks.push(
        expectRejected('native.session.respond', {
          sessionId: session.id,
          requestId: `missing-${randomUUID()}`,
          decision: 'approve',
        }),
      );
      const cursor = afterDuplicate.cursor;
      const tail = rpc('native.session.read', { sessionId: session.id, after: cursor });
      assert.equal(tail.events.length, 0, 'Cursor replay repeated already-read events');
      const followup = await complete(
        send(
          'What exact token did I ask you to remember? Reply with the token only. Do not use tools.',
        ),
      );
      assert.ok(followup.text.includes(secret), 'Follow-up lost session context');
      report.checks.push({ name: 'reconnect-cursor-and-followup-context', pass: true });
    }

    if (stages.includes('approvals')) {
      assert.equal(session.capabilities.approvals, true, 'Runner does not declare approvals');
      for (const decision of ['approve', 'deny']) {
        const target = path.join(fixture, `${decision}.txt`);
        const code = `require('fs').writeFileSync(${JSON.stringify(target)}, 'native-validation')`;
        const command = send(
          `Run this exact Node command once using your shell tool: node -e ${JSON.stringify(code)}. This writes only a disposable validation file outside the workspace. Ask for permission when required. If permission is denied, stop and acknowledge the denial. Do not use another command, another tool, or retry.`,
        );
        const answered = new Set();
        const result = await complete(command, (value) => {
          for (const event of eventsFor(value, command)) {
            if (event.type !== 'approval.requested') continue;
            const requestId = event.nativeId;
            assert.ok(requestId, 'Approval has no native request identity');
            if (answered.has(requestId)) continue;
            const requested = JSON.stringify(event.data);
            assert.ok(
              requested.includes(target),
              'Refusing approval unrelated to this disposable target',
            );
            assert.ok(requested.includes('writeFileSync'), 'Refusing an unexpected tool operation');
            rpc('native.session.respond', { sessionId: session.id, requestId, decision });
            answered.add(requestId);
          }
        });
        assert.ok(answered.size > 0, `No permission request for ${decision} proof`);
        assert.ok(
          result.events.some((event) => event.type === 'tool.started'),
          'No tool start event',
        );
        if (decision === 'approve') {
          assert.ok(
            result.events.some((event) => event.type === 'tool.completed'),
            'No tool completion event',
          );
          assert.equal(fs.readFileSync(target, 'utf8'), 'native-validation');
        } else assert.equal(fs.existsSync(target), false, 'Denied tool still wrote its target');
        report.checks.push({
          name: `approval-${decision}-side-effect`,
          pass: true,
          requestIds: [...answered],
        });
        report.checks.push(
          expectRejected('native.session.respond', {
            sessionId: session.id,
            requestId: [...answered][0],
            decision: 'approve',
          }),
        );
      }
    }

    if (stages.includes('questions')) {
      if (!session.capabilities.questions) {
        report.checks.push({
          name: 'structured-question-answer',
          skipped: true,
          reason: 'Runner does not advertise questions in this execution mode',
        });
      } else {
        const command = send(
          'Use your structured question tool once to ask: Which validation color should we choose? Offer exactly Amber and Violet. Wait for my structured answer, then reply with the selected label only. Do not answer the question yourself. Do not use shell or filesystem tools.',
        );
        const answered = new Set();
        const result = await complete(command, (value) => {
          for (const event of eventsFor(value, command)) {
            if (event.type !== 'question.requested') continue;
            assert.ok(event.request?.id, 'Question has no normalized request identity');
            assert.equal(event.nativeId, event.request.id);
            if (answered.has(event.request.id)) continue;
            assert.equal(event.request.questions?.length, 1, 'Expected one normalized question');
            const question = event.request.questions[0];
            assert.ok(question.id && question.prompt, 'Question lacks normalized ID or prompt');
            assert.ok(
              question.options.some((option) => option.label === 'Violet'),
              'Question omitted the requested answer option',
            );
            assert.equal(
              rpc('native.session.respond', {
                sessionId: session.id,
                requestId: event.request.id,
                answers: { [question.id]: ['Violet'] },
              }).responded,
              true,
            );
            answered.add(event.request.id);
          }
        });
        assert.equal(answered.size, 1, 'No structured question was answered');
        assert.ok(result.text.includes('Violet'), 'Runner did not use the structured answer');
        report.checks.push({
          name: 'structured-question-answer',
          pass: true,
          requestIds: [...answered],
        });
        report.checks.push(
          expectRejected('native.session.respond', {
            sessionId: session.id,
            requestId: [...answered][0],
            answers: { stale: ['Amber'] },
          }),
        );
      }
    }

    if (stages.includes('interrupt')) {
      const command = send(
        'Write a detailed numbered list of 500 distinct software testing techniques. Keep producing the entire list. Do not use tools.',
      );
      await wait(
        (value) => eventsFor(value, command).some((event) => event.type === 'turn.started'),
        'turn start before interrupt',
      );
      assert.equal(rpc('native.session.interrupt', { sessionId: session.id }).interrupted, true);
      await complete(command, undefined, 'interrupted');
      await wait((value) => value.session.state === 'idle', 'idle after interruption');
      report.checks.push({ name: 'interrupt-reaches-terminal-turn-and-idle', pass: true });
    }

    if (stages.includes('resume')) {
      assert.equal(session.capabilities.resume, true, 'Runner does not declare resume');
      const nativeSessionId = session.nativeSessionId;
      const oldId = session.id;
      assert.equal(rpc('native.session.close', { sessionId: oldId }).closed, true);
      report.checks.push(
        expectRejected('native.session.send', {
          sessionId: oldId,
          commandId: randomUUID(),
          text: 'This closed-session negative control must never reach inference.',
        }),
      );
      session = rpc('native.session.create', {
        runner,
        cwd,
        resumeSessionId: nativeSessionId,
        ...(model ? { model } : {}),
      }).session;
      savedSequence = 0;
      recordSession();
      assert.equal(session.nativeSessionId, nativeSessionId);
      const resumed = await complete(
        send(
          'What exact context token did I ask you to remember earlier in this conversation? Reply with that token only. Do not use tools.',
        ),
      );
      assert.ok(resumed.text.includes(secret), 'Native resume lost prior context');
      report.checks.push({ name: 'closed-native-session-resume-with-context', pass: true });
    }
    report.pass = true;
  } catch (error) {
    // Keep failure evidence bounded; subprocess diagnostics may contain account details.
    report.error = error.rpcMethod
      ? `Gateway RPC ${error.rpcMethod} failed (${error.rpcCode ?? 'transport-or-unclassified'}); inspect the isolated gateway log.`
      : error.message;
  } finally {
    if (session) {
      try {
        assert.equal(rpc('native.session.close', { sessionId: session.id }).closed, true);
        assert.equal(read().session.state, 'closed', 'Close did not terminate the native session');
      } catch (_error) {
        report.pass = false;
        report.cleanupError = 'Native session could not be closed; inspect isolated gateway.';
      }
    }
  }
  const outPath = writeEvidence(
    report,
    SCENARIO_ID,
    runner,
    outDir ?? path.join(ROOT, 'temp/native-validation/evidence'),
  );
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
