import assert from 'node:assert/strict';
import test from 'node:test';

import { type AgentContext, primaryRoleForFlow } from '@farmslot/protocol';

import {
  nativeRunConversationParams,
  nativeWorkerTabs,
  nativeWorkerTargets,
  nativeWorkerViewControl,
  selectedNativeWorkerTarget,
  slotSessionView,
} from '../src/native-worker-target.js';

const context = (id: string, role: AgentContext['role']): AgentContext => ({
  id,
  role,
  label: id,
  status: 'working',
  runId: 'run-k',
  slotId: 'slot-k',
  nativeSession: {
    sessionId: `native-${id}`,
    executionNodeId: 'node',
    ownerPrincipalId: 'owner',
    leaseId: `lease-${id}`,
    commandId: `command-${id}`,
    generation: `generation-${id}`,
    acceptedAt: '2026-10-22T07:00:00.000Z',
  },
});

test('native fixes keep their own context while following the exact current or historical owner lease', () => {
  const owner = context('dev', 'dev');
  const fix: AgentContext = {
    ...context('fix', 'review-fix'),
    nativeSession: undefined,
    nativeSessionOwner: {
      contextId: owner.id,
      sessionId: owner.nativeSession!.sessionId,
      leaseId: owner.nativeSession!.leaseId,
    },
  };
  const contexts = [owner, fix];
  const current = nativeWorkerTargets(contexts).find((target) => target.contextId === fix.id)!;
  assert.equal(current.binding, owner.nativeSession);
  assert.equal(current.readOnly, false);
  assert.equal(nativeWorkerTabs(contexts, 'slot-k').at(-1)?.target.contextId, fix.id);
  const params = nativeRunConversationParams({ agentContexts: contexts, id: 'run-k' }, fix);
  assert.equal(params?.contextId, fix.id);
  owner.nativeSessionHistory = [{ ...owner.nativeSession!, releasedAt: 'released' }];
  owner.nativeSession = { ...owner.nativeSession!, sessionId: 'replacement', leaseId: 'new-lease' };
  const historical = nativeWorkerTargets(contexts).find((target) => target.contextId === fix.id)!;
  assert.equal(historical.binding, owner.nativeSessionHistory[0]);
  assert.equal(historical.readOnly, true);
  owner.nativeSessionHistory = [];
  assert.equal(
    nativeWorkerTargets(contexts).some((target) => target.contextId === fix.id),
    false,
  );
});

test('a native binding awaiting generation remains a native tab with controls disabled', () => {
  const pending = context('review', 'review');
  delete pending.nativeSession!.generation;
  const targets = nativeWorkerTargets([pending]);
  assert.equal(targets.length, 1);
  assert.equal(nativeWorkerViewControl(targets[0], undefined), undefined);
});

test('slot-bound dev, review and fix contexts all expose their exact native conversation', () => {
  const contexts = [
    context('dev', 'dev'),
    context('rev-codex-native', 'review'),
    context('review-fix', 'review-fix'),
  ];
  const targets = nativeWorkerTargets(contexts);
  assert.deepEqual(
    targets.map((target) => target.contextId),
    contexts.map((item) => item.id),
  );
  for (const [index, target] of targets.entries()) {
    assert.equal(target.binding, contexts[index].nativeSession);
    assert.equal(target.readOnly, false);
  }
});

test('warm reviewer rounds retain their own lease and owner-governed controls', () => {
  const old = context('review-round-1', 'review');
  const current = context('review-round-2', 'review');
  old.nativeSession = {
    ...old.nativeSession!,
    sessionId: current.nativeSession!.sessionId,
    closedAt: 'closed',
    releasedAt: 'released',
  };
  const targets = nativeWorkerTargets([old, current]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].readOnly, true);
  assert.equal(selectedNativeWorkerTarget(targets, ''), targets[1]);
  assert.equal(nativeWorkerViewControl(targets[0], undefined), undefined);
  assert.notEqual(targets[0].binding.leaseId, targets[1].binding.leaseId);
});

test('slot-free and archived worker attempts use the same model', () => {
  const reviewer = context('review', 'review');
  reviewer.slotId = null;
  reviewer.nativeSessionHistory = [
    { ...reviewer.nativeSession!, leaseId: 'old-lease', releasedAt: 'released' },
  ];
  const targets = nativeWorkerTargets([reviewer]);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].readOnly, false);
  assert.equal(targets[1].readOnly, true);
  assert.equal(targets[1].binding.leaseId, 'old-lease');
});

test('slot window tabs expose only that slot and retain review round identity', () => {
  const first = context('review-1', 'review');
  first.runner = 'codex';
  first.reviewLoopNumber = 1;
  const other = context('other-slot', 'review');
  other.slotId = 'another-slot';
  const tabs = nativeWorkerTabs([first, other], 'slot-k');
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].label, 'rev-codex native 1');
  assert.equal(tabs[0].target.contextId, first.id);
});

test('an explicit tmux window replaces native primary and fix-bug conversations', () => {
  for (const role of ['primary', primaryRoleForFlow('fix-bug')] as const) {
    const worker = context('worker', role);
    const selected = { slotId: 'slot-k', contextId: worker.id, tmux: false };
    assert.equal(slotSessionView([worker], selected).target?.contextId, worker.id);
    const tmux = slotSessionView([worker], { ...selected, tmux: true });
    assert.equal(tmux.target, undefined);
    assert.equal(tmux.bareSession, true);
    assert.equal(tmux.unavailable, false);
  }
});
