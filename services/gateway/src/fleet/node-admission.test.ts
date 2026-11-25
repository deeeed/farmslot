// One live node per machine: a second process for a connected machine is refused while the
// connected one answers; a closed, stopping or silent one is replaced (only a silent one's socket
// is closed afterwards); the same process reconnecting is replaced as before.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebSocket } from 'ws';

import {
  admitNodeConnection,
  type ConnectedNode,
  getAllNodes,
  getNode,
  type NodeAdmissionDeps,
  type NodeProbeVerdict,
  noteNodeFrame,
  registerNode,
  unregisterByWs,
} from './machine-registry.js';

function socket(open = true) {
  const state = { terminated: false };
  const ws = {
    readyState: open ? 1 : 3,
    OPEN: 1,
    terminate: () => void (state.terminated = true),
  } as WebSocket;
  return { ws, state };
}

function deps(
  verdict: NodeProbeVerdict | (() => Promise<NodeProbeVerdict>),
  extra: Partial<NodeAdmissionDeps> = {},
) {
  const calls: ConnectedNode[] = [];
  const value: NodeAdmissionDeps = {
    probe: async (node) => {
      calls.push(node);
      return typeof verdict === 'function' ? verdict() : verdict;
    },
    isStopping: () => false,
    budgetMs: 50,
    ...extra,
  };
  return { calls, value };
}

let seq = 0;
function connected(t: test.TestContext, pid = 100, open = true) {
  const machine = `admission-${++seq}`;
  const incumbent = socket(open);
  registerNode(machine, pid, incumbent.ws);
  t.after(() => unregisterByWs(incumbent.ws));
  return { machine, incumbent };
}

test('the first node for a machine is admitted without a probe', async () => {
  const probe = deps('answered');
  const admission = await admitNodeConnection('admission-fresh', 1, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.equal(probe.calls.length, 0);
});

test('the same process reconnecting on a new socket is admitted without a probe', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const probe = deps('answered');
  const admission = await admitNodeConnection(machine, 100, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.equal(admission.kind === 'admitted' ? admission.terminateAfterRegister : 'x', undefined);
  assert.equal(probe.calls.length, 0);
  assert.equal(incumbent.state.terminated, false);
});

test('a second process is refused while the connected node answers, naming both pids', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const probe = deps('answered');
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'refused');
  if (admission.kind !== 'refused') return;
  assert.equal(admission.code, 'NODE_ALREADY_CONNECTED');
  assert.equal(admission.incumbentPid, 100);
  assert.match(admission.message, /already connected \(pid 100\); refused pid 200/);
  assert.equal(getNode(machine)?.ws, incumbent.ws, 'the connected node keeps the machine');
  assert.equal(incumbent.state.terminated, false);
  assert.equal(
    getAllNodes().find((node) => node.machine === machine)?.lastRefusedDuplicate?.pid,
    200,
  );
});

test('a connected node that is shutting down is replaced without closing its socket', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const probe = deps('stopping');
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.equal(admission.kind === 'admitted' ? admission.terminateAfterRegister : 'x', undefined);
  assert.equal(incumbent.state.terminated, false, 'its accepted commands still close out');
});

test('a connected node already known to be stopping is replaced without a probe', async (t) => {
  const { machine } = connected(t, 100);
  const probe = deps('answered', { isStopping: () => true });
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.equal(probe.calls.length, 0);
});

test('a connected node whose socket is closed is replaced without a probe', async (t) => {
  const { machine } = connected(t, 100, false);
  const probe = deps('answered');
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.equal(probe.calls.length, 0);
});

test('a silent connected node is replaced, and its socket is closed once the new one registers', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const never = deps(() => new Promise<NodeProbeVerdict>(() => {}));
  const admission = await admitNodeConnection(machine, 200, socket().ws, never.value);
  assert.equal(admission.kind, 'admitted');
  if (admission.kind !== 'admitted') return;
  assert.equal(admission.terminateAfterRegister, incumbent.ws);
  assert.equal(getNode(machine)?.ws, incumbent.ws, 'registration, not admission, replaces it');
  admission.release();
});

test('a connected node that sends frames during a slow probe counts as alive', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const busy = deps(async () => {
    noteNodeFrame(incumbent.ws);
    return new Promise<NodeProbeVerdict>(() => {});
  });
  const admission = await admitNodeConnection(machine, 200, socket().ws, busy.value);
  assert.equal(admission.kind, 'refused');
});

test('a stopping answer wins over frames seen during the probe', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  let stopping = false;
  const probe = deps(
    async () => {
      // The NODE_SHUTTING_DOWN reply is itself a frame on the connected node's socket.
      noteNodeFrame(incumbent.ws);
      stopping = true;
      return 'silent';
    },
    { isStopping: () => stopping },
  );
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
  assert.deepEqual(admission.kind === 'admitted' ? admission.replaced : undefined, {
    pid: 100,
    verdict: 'stopping',
  });
});

test('a connected node that leaves during the probe lets the newcomer in', async (t) => {
  const { machine, incumbent } = connected(t, 100);
  const probe = deps(async () => {
    unregisterByWs(incumbent.ws);
    return 'silent';
  });
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'admitted');
});

test('a second newcomer during a probe is refused at once with a transient code', async (t) => {
  const { machine } = connected(t, 100);
  let answer: (verdict: NodeProbeVerdict) => void = () => {};
  const slow = deps(() => new Promise<NodeProbeVerdict>((resolve) => (answer = resolve)), {
    budgetMs: 5_000,
  });
  const first = admitNodeConnection(machine, 200, socket().ws, slow.value);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await admitNodeConnection(machine, 300, socket().ws, deps('answered').value);
  assert.equal(second.kind, 'refused');
  assert.equal(second.kind === 'refused' ? second.code : '', 'NODE_ADMISSION_IN_PROGRESS');
  answer('answered');
  assert.equal((await first).kind, 'refused');
  // The guard is released: the next newcomer is probed again.
  assert.equal(
    (await admitNodeConnection(machine, 400, socket().ws, deps('answered').value)).kind,
    'refused',
  );
});

test('the same process reconnecting during another newcomer probe is still admitted', async (t) => {
  const { machine } = connected(t, 100);
  const slow = deps(() => new Promise<NodeProbeVerdict>(() => {}), { budgetMs: 200 });
  const duplicate = admitNodeConnection(machine, 200, socket().ws, slow.value);
  await new Promise((resolve) => setImmediate(resolve));
  const own = await admitNodeConnection(machine, 100, socket().ws, deps('answered').value);
  assert.equal(own.kind, 'admitted', 'the connected process is never locked out by a duplicate');
  await duplicate;
});

test('a newcomer whose incumbent changed during the probe retries instead of taking over', async (t) => {
  const { machine } = connected(t, 100);
  const replacement = socket();
  t.after(() => unregisterByWs(replacement.ws));
  const probe = deps(async () => {
    registerNode(machine, 100, replacement.ws);
    return 'silent';
  });
  const admission = await admitNodeConnection(machine, 200, socket().ws, probe.value);
  assert.equal(admission.kind, 'refused');
  assert.equal(admission.kind === 'refused' ? admission.code : '', 'NODE_ADMISSION_IN_PROGRESS');
});
