#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const phase = process.argv[2];
const statePath = process.env.NATIVE_COMPANION_WORKER_STATE;
assert(statePath && process.env.NATIVE_COMPANION_TOKEN_FILE);
process.env.FARMSLOT_GATEWAY = 'ws://127.0.0.1:18777';
process.env.FARMSLOT_GATEWAY_TOKEN = fs
  .readFileSync(process.env.NATIVE_COMPANION_TOKEN_FILE, 'utf8')
  .trim();
const { rpc, wait } = await import(
  path.join(root, 'scripts/runner-validation/scenarios/native-worker-lifecycle.mjs')
);
const { writeNativeFixtureTask } = await import(
  path.join(root, 'scripts/runner-validation/lib/native-task.mjs')
);
const { pinnedWorkerTarget } = await import(
  path.join(root, 'scripts/runner-validation/scenarios/native-worker-read.mjs')
);
const { readPinnedWorkerHistory, assertWorkerHistoryTransfer } = await import(
  path.join(root, 'scripts/runner-validation/scenarios/native-worker-history.mjs')
);
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const evidence = (name, data) => {
  fs.mkdirSync(`${statePath}.evidence`, { recursive: true });
  fs.writeFileSync(`${statePath}.evidence/${name}.json`, JSON.stringify(data, null, 2) + '\n');
};
const target = (side = 'source') =>
  pinnedWorkerTarget(state[side].runId, state[side].contextId, state[side].binding.leaseId);
const snapshot = (side = 'source') =>
  readPinnedWorkerHistory(state[side].runId, state[side].contextId, state[side].binding.leaseId);
const create = async (successor = false) => {
  const id = `MOBILE-${Date.now()}`;
  const taskFile = path.join(root, 'projects', state.project, 'tasks/dev', id, 'TASK.md');
  const marker = successor ? 'mobile-successor.txt' : 'mobile-worker.txt';
  const value = successor ? state.successorToken : state.token;
  await writeNativeFixtureTask(
    taskFile,
    `# Worker: dev\n\n- Task profile: dev\n\n## Checklist\n\n- [ ] Write ${marker} containing exactly ${value}.\n- [ ] Check both boxes in CHECKLIST.md.\n\nThen end the turn without a terminal signal. Remain in Farmslot monitoring. Do not commit, contact services, or modify other files.\n`,
    state.project,
  );
  const params = {
    flowType: 'dev',
    project: state.project,
    ticketOrPr: id,
    slotId: state.slotId,
    allowedSlots: [state.slotId],
    taskFile,
    runner: 'codex',
    model: 'gpt-6-astra',
    mode: 'interactive',
    skipPrepare: true,
    safetyTier: 'full-auto',
  };
  if (successor) {
    params.parentRunId = state.source.runId;
    params.familyId = state.familyId;
    params.engineState = { flags: { warmSessionReuse: true } };
  }
  const created = rpc('run.createNative', params).run;
  const side = successor ? 'successor' : 'source';
  state[side] = { runId: created.id };
  save();
  const run = await wait(
    () => rpc('run.get', { runId: created.id }).run,
    (r) => {
      assert(!['failed', 'blocked', 'cancelled'].includes(r.status), r.error);
      return r.status === 'monitoring';
    },
    240000,
  );
  const context = run.agentContexts.find((c) => c.nativeSession);
  assert(context?.nativeSession?.generation);
  state[side] = { runId: run.id, contextId: context.id, binding: context.nativeSession };
  state.familyId = run.familyId;
  save();
  const page = await wait(
    () => snapshot(side),
    (p) =>
      p.commands.some(
        (c) => c.commandId === context.nativeSession.commandId && c.outcome === 'completed',
      ) && p.session.state === 'idle',
    240000,
  );
  assert.equal(fs.readFileSync(path.join(state.cwd, marker), 'utf8').trim(), value);
  evidence(`${side}-ready`, page);
  return page;
};
if (phase === 'setup') {
  assert(!fs.existsSync(statePath), 'Use a new private proof state');
  const slot = rpc('fleet.status').fleet.slots.find((s) => s.slot === 'native-worker-proof');
  assert(slot && slot.currentRunId === null && slot.lifecycle === 'ready');
  assert(fs.realpathSync(slot.repo).startsWith(path.join(root, 'temp/native-validation') + '/'));
  state = {
    slotId: slot.slot,
    project: slot.project,
    cwd: slot.repo,
    token: randomUUID(),
    successorToken: randomUUID(),
  };
  save();
  await create();
} else if (phase === 'open-run') {
  assert(process.env.IOS_SIMULATOR);
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development:///workspace/run/${state.source.runId}/timeline`,
  ]);
} else if (phase === 'open-history') {
  const t = target();
  const p = new URLSearchParams({
    sessionId: t.sessionId,
    executionNodeId: t.executionNodeId,
    ...t.worker,
  });
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development:///native?${p}`,
  ]);
} else if (phase === 'open-stale') {
  const t = target();
  const page = snapshot();
  state.staleCommandCount = page.commands.length;
  save();
  const params = new URLSearchParams({
    sessionId: t.sessionId,
    executionNodeId: t.executionNodeId,
    ...t.worker,
    generation: 'stale-mobile-generation',
    draft: 'Write mobile-stale-input.txt and end this turn.',
  });
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development:///native?${params}`,
  ]);
} else if (phase === 'verify-no-mobile') {
  const page = snapshot();
  assert.equal(page.commands.length, state.staleCommandCount);
  assert.equal(fs.existsSync(path.join(state.cwd, 'mobile-stale-input.txt')), false);
  evidence('stale-input-refused', page);
} else if (phase === 'verify-mobile') {
  const p = await wait(
    () => snapshot(),
    (p) => p.commands.some((c) => c.commandId.startsWith('mobile-') && c.outcome === 'completed'),
    120000,
  );
  const c = p.commands.find((c) => c.commandId.startsWith('mobile-') && c.outcome === 'completed');
  assert.equal(p.session.generation, state.source.binding.generation);
  assert.equal(p.session.workerLeaseId, state.source.binding.leaseId);
  assert.equal(
    p.events.filter((e) => e.type === 'command.submitted' && e.commandId === c.commandId).length,
    1,
  );
  const text = p.events
    .filter((e) => e.type === 'text.delta' && e.commandId === c.commandId)
    .map((e) => e.text)
    .join('');
  assert(text.includes(state.token), 'Mobile follow-up lost original worker memory');
  state.mobileCommand = c.commandId;
  save();
  evidence('mobile-input', p);
} else if (phase === 'handoff') {
  const before = snapshot();
  evidence('before-transfer', before);
  const successor = await create(true);
  const source = snapshot();
  assertWorkerHistoryTransfer(before, source, successor);
  assert.equal(source.session.id, successor.session.id);
  assert.notEqual(source.scope.leaseId, successor.scope.leaseId);
  assert(!JSON.stringify(source.events).includes(state.successorToken));
  state.sourceEndAt = source.scope.endAt;
  state.successorCommandCount = successor.commands.length;
  save();
  evidence('source-history', source);
  evidence('successor-history', successor);
} else if (phase === 'verify-history') {
  const source = snapshot();
  const successor = snapshot('successor');
  assert(source.scope.released);
  assert.equal(source.scope.endAt, state.sourceEndAt);
  assert(!JSON.stringify(source.events).includes(state.successorToken));
  assert.equal(successor.commands.length, state.successorCommandCount);
  evidence('mobile-history-check', source);
} else if (phase === 'cleanup') {
  for (const side of ['successor', 'source']) {
    if (!state[side]?.runId) continue;
    const r = rpc('run.get', { runId: state[side].runId }).run;
    if (!['done', 'cancelled', 'failed'].includes(r.status))
      rpc('run.cancel', { runId: r.id, reason: 'Private Companion proof complete' });
  }
  const sessions = rpc('native.session.list', { executionNodeId: 'local' }).sessions;
  assert(sessions.find((s) => s.id === state.source.binding.sessionId)?.processStopped);
  assert.equal(
    rpc('fleet.status').fleet.slots.find((s) => s.slot === state.slotId).currentRunId,
    null,
  );
  evidence(
    'cleanup',
    sessions.filter((s) => s.id === state.source.binding.sessionId),
  );
} else throw Error(`Unknown phase ${phase}`);
console.log(
  JSON.stringify({ phase, pass: true, source: state.source, successor: state.successor }),
);
