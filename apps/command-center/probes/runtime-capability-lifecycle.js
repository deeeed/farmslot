// CDP probe: exercise the real browser capability lifecycle through Gateway RPC and UI release.
// Run on #slot/<slot-id>?activity=info after Command Center is connected.

const slotId = location.hash.match(/^#slot\/([^?]+)/)?.[1];
if (!slotId) throw new Error('runtime capability probe requires a #slot/<slot-id> route');

function deep(selector, root = document) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const nested = deep(selector, element.shadowRoot);
      if (nested) return nested;
    }
  }
  return null;
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime capability probe timed out');
}

const gatewayUrl = localStorage.getItem('farmslot.gateway.url');
if (!gatewayUrl) throw new Error('Command Center has no persisted Gateway URL');
const socket = new WebSocket(gatewayUrl);
const pending = new Map();
let nextId = 0;
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  message.ok
    ? request.resolve(message.payload ?? message.result)
    : request.reject(new Error(JSON.stringify(message.error ?? message)));
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('Gateway connection failed')), {
    once: true,
  });
});

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = `runtime-capability-probe-${++nextId}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

const ownerRunId = `runtime-capability-cdp-${Date.now()}`;
const requirement = {
  capabilityId: 'browser-cdp',
  reason: 'Committed CDP lifecycle probe',
  mode: 'visual',
};
let lease;
let released = false;
try {
  await rpc('auth.connect', {
    clientKind: 'ui',
    clientName: 'runtime-capability-cdp-probe',
    ...(localStorage.getItem('farmslot.gateway.token')
      ? { token: localStorage.getItem('farmslot.gateway.token') }
      : {}),
    ...(localStorage.getItem('farmslot.gateway.password')
      ? { password: localStorage.getItem('farmslot.gateway.password') }
      : {}),
  });

  let status = await rpc('runtime.capability.status', { slotId });
  const activeLease = status.leases.find(
    (candidate) =>
      candidate.capabilityId === 'browser-cdp' &&
      ['queued', 'acquiring', 'acquired', 'releasing'].includes(candidate.state),
  );
  if (activeLease) {
    throw new Error(
      `refusing to adopt active browser-cdp lease ${activeLease.id} owned by ${activeLease.owner.runId}`,
    );
  }
  const acquired = await rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'browser-cdp',
    ownerRunId,
    proofRequirement: requirement,
  });
  if (!acquired.ok || acquired.lease.state !== 'acquired') {
    throw new Error(`browser acquire failed: ${JSON.stringify(acquired)}`);
  }
  lease = acquired.lease;

  const conflict = await rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: 'browser-cdp',
    ownerRunId: `${lease.owner.runId}-conflict-probe`,
    proofRequirement: requirement,
  });
  if (conflict.ok || conflict.conflict?.kind !== 'lease-conflict') {
    throw new Error(`exclusive conflict was not preserved: ${JSON.stringify(conflict)}`);
  }

  const panel = await waitFor(() => deep('[data-testid="runtime-capabilities-panel"]'));
  await waitFor(
    () => panel.textContent.includes('Acquired') && panel.textContent.includes(lease.owner.runId),
  );
  const release = await waitFor(() =>
    deep('[data-testid="runtime-capability-release-browser-cdp"]'),
  );
  release.click();
  await waitFor(async () => {
    status = await rpc('runtime.capability.status', { slotId });
    return status.leases.some(
      (candidate) => candidate.id === lease.id && candidate.state === 'released',
    );
  });
  released = true;
  await waitFor(
    () => panel.textContent.includes('Released') && panel.textContent.includes('No active owner'),
  );

  return {
    slotId,
    acquiredLeaseId: lease.id,
    ownerRunId: lease.owner.runId,
    conflictOwner: conflict.conflict.owner.runId,
    released: true,
  };
} finally {
  if (lease && !released) {
    await rpc('runtime.capability.release', {
      slotId,
      ownerRunId,
      leaseId: lease.id,
      force: true,
    });
  }
  socket.close();
}
