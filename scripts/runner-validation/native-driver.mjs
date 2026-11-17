// Manual live contract proof. Creates and closes only its own standalone session.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../../packages/cli/src/gateway-client.ts';
import { resolveGatewayTarget } from '../../packages/cli/src/gateway-profiles.ts';

import { cleanupOnExit } from './lib/isolated-stack.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.FARMSLOT_NATIVE_DRIVER_OUTPUT;
const profile = process.env.FARMSLOT_NATIVE_DRIVER_PROFILE;
assert(output && profile, 'Set FARMSLOT_NATIVE_DRIVER_OUTPUT and FARMSLOT_NATIVE_DRIVER_PROFILE');
mkdirSync(output, { recursive: true, mode: 0o700 });
const workspace = mkdtempSync(path.join(tmpdir(), 'native-driver-proof-'));
const stateDir = path.join(workspace, 'driver-state');
const save = (name, value) =>
  writeFileSync(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const target = resolveGatewayTarget({ gateway: profile });
const client = new GatewayClient({
  url: target.url,
  credential: target.credential,
  timeout: 30_000,
});
const connection = await client.connect();
const executionNodeId = process.env.FARMSLOT_NATIVE_DRIVER_NODE ?? 'local';
const nativeCwd = process.env.FARMSLOT_NATIVE_DRIVER_CWD ?? workspace;
const queueOnly = process.env.FARMSLOT_NATIVE_DRIVER_SCENARIO === 'queue';
const runner = process.env.FARMSLOT_NATIVE_DRIVER_RUNNER ?? 'codex';
const model = process.env.FARMSLOT_NATIVE_DRIVER_MODEL ?? 'gpt-6-luna';
let session, failure;
const result = { checks: [], workspace, startedAt: new Date().toISOString() };
const children = new Set();
const cleanup = cleanupOnExit(async () => {
  for (const child of children) child.kill('SIGTERM');
  try {
    if (session) {
      await connection.call('native.session.close', { executionNodeId, sessionId: session.id });
      result.cleaned = true;
    }
  } finally {
    connection.close();
  }
});
const call = (method, params) => connection.call(method, params);
const until = async (read, accept, label) => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(200);
  }
  throw new Error('Timed out: ' + label);
};
const descriptorFile = path.join(workspace, 'target.json');
const driver = async (operation, input = '', argument) => {
  const args = [
    path.join(root, '.agents/skills/tmux-model-driver/scripts/run-driver.sh'),
    operation,
    `native:${descriptorFile}`,
    runner,
    ...(argument === undefined ? [] : [argument]),
  ];
  const child = spawn('bash', args, {
    cwd: workspace,
    env: { ...process.env, TMUX_MODEL_DRIVER_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert([0, 2].includes(code), `driver exited ${code}: ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    children.delete(child);
  }
};
try {
  const retained = process.env.FARMSLOT_NATIVE_DRIVER_SESSION;
  if (retained) {
    session = (
      await call('native.session.read', { executionNodeId, sessionId: retained, limit: 1 })
    ).session;
    assert.equal(session.cwd, nativeCwd, 'Retained proof session must match the owned cwd');
  } else {
    const created = await call('native.session.create', {
      executionNodeId,
      runner,
      cwd: nativeCwd,
      model,
      ...(runner === 'codex'
        ? {
            mode: queueOnly ? 'default' : 'plan',
            effort: 'low',
            ...(queueOnly ? { approvalMode: 'bypass' } : {}),
          }
        : {}),
    });
    session = created.session;
  }
  save('created', session);
  if (!queueOnly)
    assert(session.capabilities.questions, 'Owned session must support structured questions');
  const pin = {
    gateway: profile,
    executionNodeId,
    sessionId: session.id,
    generation: session.generation,
  };
  writeFileSync(descriptorFile, JSON.stringify(pin));
  const rpcTarget = { executionNodeId, sessionId: session.id };
  const read = () => call('native.session.read', { ...rpcTarget, limit: 500 });
  if (queueOnly) {
    assert(
      /^\/tmp\/[a-zA-Z0-9-]+$/.test(nativeCwd),
      'Queue proof requires an owned simple /tmp path',
    );
    const release = nativeCwd + '/release';
    const held = await driver(
      'send',
      `This is an owned transport QA. Use your shell tool once to run: while [ ! -f ${release} ]; do sleep 0.1; done . Wait for that tool to finish, then reply HOLD_DONE. Do not do repository work.`,
    );
    save('held', held);
    await until(
      read,
      (p) =>
        p.events.some((e) => e.commandId === held.evidence.commandId && e.type === 'tool.started'),
      'owned wait tool started',
    );
    const queued = await driver('send', 'Reply only QUEUED_REPLY_OK. Do not use tools.');
    save('queued', queued);
    assert.equal(queued.verification, 'queued');
    assert.equal(queued.submitted, true);
    if (executionNodeId === 'local') writeFileSync(release, 'release');
    else {
      const ssh = process.env.FARMSLOT_NATIVE_DRIVER_SSH;
      assert(ssh, 'Remote queue proof requires the node SSH alias');
      execFileSync('ssh', [ssh, 'touch', release]);
    }
    const done = await until(
      read,
      (p) =>
        p.commands.some(
          (c) => c.commandId === queued.evidence.commandId && c.state === 'completed',
        ),
      'queued native reply',
    );
    save('completed', done);
    const retry = await driver('send', 'Reply only QUEUED_REPLY_OK. Do not use tools.');
    save('reconciled', retry);
    assert.equal(retry.verification, 'submitted');
    assert.equal(retry.evidence.commandId, queued.evidence.commandId);
    const text = done.events
      .filter((e) => e.type === 'text.delta' && e.commandId === queued.evidence.commandId)
      .map((e) => e.text ?? '')
      .join('');
    assert(text.includes('QUEUED_REPLY_OK'), 'Queued reply text comes from native deltas');
    result.checks = [
      'real native durable queue',
      'queued reply completes',
      'retry reconciles to accepted without re-send',
    ];
  } else {
    const questionPrompt =
      'This is an owned transport QA session, not repository work. Do not read or change files or run commands. Use your structured question tool now to ask Which color?, with exactly Violet and Green options. Wait for the answer, then reply with only the chosen color. This is the required user decision; do not pick a color yourself.';
    const sent = await driver('send', questionPrompt);
    save('send', sent);
    assert(sent.submitted || sent.evidence?.commandId, 'Native send has a durable command receipt');
    const questionPage = await until(
      read,
      (page) => page.pendingRequests.some((e) => e.type === 'question.requested'),
      'actual native question',
    );
    save('question-page', questionPage);
    const commandId = sent.evidence.commandId;
    const retry = await driver('send', questionPrompt);
    save('retry', retry);
    assert.equal(retry.evidence.commandId, commandId);
    assert(retry.submitted);
    const pending = await driver('state');
    save('pending', pending);
    assert(pending.pending_question);
    const blocked = await driver(
      'send',
      'Do not answer the question; this fresh message must be blocked.',
    );
    save('blocked', blocked);
    assert.equal(blocked.verification, 'pending_question');
    assert.equal(blocked.submitted, false);
    const answers = Object.fromEntries(pending.question.questions.map((q) => [q.id, ['Violet']]));
    assert(pending.question.questions.every((q) => q.options.some((o) => o.label === 'Violet')));
    const answered = await driver(
      'answer',
      JSON.stringify({ answers }),
      pending.question_fingerprint,
    );
    save('answered', answered);
    assert.equal(answered.action_sent, true);
    await until(
      read,
      (page) => page.commands.some((c) => c.commandId === commandId && c.state === 'completed'),
      'question completion',
    );
    const followup = await driver('send', 'Reply with exactly DRIVER_REPLY_OK. Do not use tools.');
    save('followup', followup);
    const done = await until(
      read,
      (page) =>
        page.commands.some(
          (c) => c.commandId === followup.evidence.commandId && c.state === 'completed',
        ),
      'followup completion',
    );
    save('completed', done);
    const conversation = await driver('read', '', '0');
    save('conversation', conversation);
    assert(
      conversation.events
        .filter((e) => e.type === 'text.delta' && e.commandId === followup.evidence.commandId)
        .map((e) => e.text ?? '')
        .join('')
        .includes('DRIVER_REPLY_OK'),
    );
    assert.equal(
      done.events.filter((e) => e.type === 'command.submitted' && e.commandId === commandId).length,
      1,
    );
    assert.equal(
      done.events.filter((e) => e.type === 'command.accepted' && e.commandId === commandId).length,
      1,
    );
    const stale = { ...pin, generation: 'stale-generation' };
    writeFileSync(descriptorFile, JSON.stringify(stale));
    const refused = await driver('send', 'Must not submit on a stale generation');
    save('stale', refused);
    assert.equal(refused.verification, 'stale_target');
    writeFileSync(descriptorFile, JSON.stringify(pin));
    result.checks = [
      'real CLI native delivery',
      'idempotent retry, one submission and acceptance',
      'structured pending question blocks fresh send',
      'explicit Violet answer and model completion',
      'reply read from native conversation events',
      'stale generation refuses',
    ];
  }
  result.status = 'PASS';
  result.sessionId = session.id;
  result.generation = session.generation;
} catch (error) {
  failure = error;
  result.status = 'FAIL';
  result.error = error.message;
} finally {
  try {
    await cleanup();
  } catch (error) {
    result.cleanupError = error.message;
    failure ??= error;
    result.status = 'FAIL';
  }
  result.endedAt = new Date().toISOString();
  save('result', result);
}
if (failure) throw failure;
console.log(JSON.stringify(result));
