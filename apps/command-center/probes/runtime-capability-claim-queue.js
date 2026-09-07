// CDP probe: fleet-scoped claim contention as Slot View renders it.
//
// Drives the real thing end to end through Gateway RPC — one run takes a
// fleet-scoped claim on this slot, a second run on ANOTHER slot asks to queue
// behind it — then asserts that the panel this page is showing reports the
// queue place and the blocking run. Nothing is written into UI state; the panel
// re-renders from the lifecycle events the Gateway broadcasts.
//
// Run on #slot/<slot-id>?activity=info after Command Center is connected.

const slotId = location.hash.match(/^#slot\/([^?]+)/)?.[1];
if (!slotId) throw new Error('claim queue probe requires a #slot/<slot-id> route');

const CAPABILITY_ID = 'recording';
const CLAIM_ID = 'capture-helper';

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

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('claim queue probe timed out');
}

// The same resolution the app itself uses: a stored URL when the operator
// pinned one, otherwise the page's own origin, which Vite proxies to the
// gateway in dev. Hardcoding a port here would pin the probe to one machine.
const gatewayUrl =
  localStorage.getItem('farmslot.gateway.url') ??
  `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
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
    const id = `claim-queue-probe-${++nextId}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

const holderRunId = `claim-queue-holder-${Date.now()}`;
const waiterRunId = `claim-queue-waiter-${Date.now()}`;
const requirement = {
  capabilityId: CAPABILITY_ID,
  reason: 'Committed CDP claim-queue probe',
  mode: 'state',
};
const result = { slotId, gatewayUrl, capabilityId: CAPABILITY_ID, claimId: CLAIM_ID };
let holderLease = null;
let waiterLeaseId = null;
try {
  await rpc('auth.connect', {
    clientKind: 'ui',
    clientName: 'runtime-capability-claim-queue-probe',
    ...(localStorage.getItem('farmslot.gateway.token')
      ? { token: localStorage.getItem('farmslot.gateway.token') }
      : {}),
    ...(localStorage.getItem('farmslot.gateway.password')
      ? { password: localStorage.getItem('farmslot.gateway.password') }
      : {}),
  });

  // The scope has to be real in the live catalog, or nothing below means fleet.
  const catalog = await rpc('runtime.capability.list', { slotId });
  const entry = (catalog.capabilities ?? []).find((item) => item.id === CAPABILITY_ID);
  if (!entry) throw new Error(`${CAPABILITY_ID} is not in this slot's catalog`);
  result.declaredClaim = entry.cost.resources.find((claim) => claim.id === CLAIM_ID) ?? null;
  if (result.declaredClaim?.scope !== 'fleet') {
    throw new Error(`'${CLAIM_ID}' is scoped ${result.declaredClaim?.scope ?? 'unset'}, not fleet`);
  }

  // A second slot on the same project to contend from.
  const fleet = await rpc('fleet.status', {});
  const slots = fleet.fleet?.slots ?? [];
  const here = slots.find((slot) => slot.slot === slotId);
  const other = slots.find(
    (slot) =>
      slot.slot !== slotId &&
      slot.project === here?.project &&
      slot.machine === here?.machine &&
      !slot.currentRunId,
  );
  if (!other) throw new Error(`no second idle ${here?.project} slot on ${here?.machine}`);
  result.waiterSlotId = other.slot;

  const existing = (await rpc('runtime.capability.status', { slotId })).leases.find(
    (lease) =>
      lease.capabilityId === CAPABILITY_ID &&
      ['queued', 'acquiring', 'acquired', 'releasing'].includes(lease.state),
  );
  if (existing) {
    throw new Error(
      `refusing to disturb a live ${CAPABILITY_ID} lease owned by ${existing.owner.runId}`,
    );
  }

  const acquired = await rpc('runtime.capability.acquire', {
    slotId,
    capabilityId: CAPABILITY_ID,
    ownerRunId: holderRunId,
    proofRequirement: requirement,
  });
  if (!acquired.ok) {
    // Gateway admission sheds medium-cost acquires above the load threshold.
    // Reported as blocked, never as a pass: the panel state this probe exists to
    // check cannot be reached without a real holder.
    result.blockedByAdmission = acquired.conflict?.kind === 'host-pressure';
    result.blockedReason = acquired.conflict?.reason ?? 'acquire refused';
    result.pass = false;
    return result;
  }
  holderLease = acquired.lease;
  result.holderLeaseId = holderLease.id;
  result.holderClaims = holderLease.claims ?? null;

  // The waiter is on the OTHER slot, so only fleet scope can make it conflict.
  const queued = await rpc('runtime.capability.acquire', {
    slotId: other.slot,
    capabilityId: CAPABILITY_ID,
    ownerRunId: waiterRunId,
    proofRequirement: requirement,
    queueOnConflict: true,
  });
  if (queued.ok || queued.conflict?.kind !== 'scoped-wait') {
    throw new Error(`expected a scoped-wait conflict, got ${JSON.stringify(queued)}`);
  }
  waiterLeaseId = queued.conflict.queuedLeaseId;
  result.scopedWait = queued.conflict;

  // What Slot View shows for the WAITING slot. Navigated, not injected: the
  // panel loads its own status for whichever slot the route names.
  location.hash = `#slot/${other.slot}?activity=info`;
  const queueLine = await waitFor(() =>
    deep(`[data-testid="runtime-capability-claim-queue-${CAPABILITY_ID}"]`),
  );
  result.renderedQueueLine = queueLine.textContent.trim();
  result.renderedClaimId = queueLine.getAttribute('data-claim-id');
  result.renderedPosition = queueLine.getAttribute('data-claim-position');
  result.renderedBlockingRun = queueLine.getAttribute('data-claim-blocking-run');
  if (result.renderedClaimId !== CLAIM_ID) {
    throw new Error(`panel named claim ${result.renderedClaimId}`);
  }
  if (result.renderedPosition !== '1') {
    throw new Error(`panel showed position ${result.renderedPosition}, expected 1`);
  }
  if (result.renderedBlockingRun !== holderRunId) {
    throw new Error(`panel named ${result.renderedBlockingRun} as the blocking run`);
  }
  result.pass = true;
  return result;
} finally {
  if (waiterLeaseId) {
    await rpc('runtime.capability.release', {
      slotId: result.waiterSlotId,
      ownerRunId: waiterRunId,
      leaseId: waiterLeaseId,
      force: true,
    });
  }
  if (holderLease) {
    await rpc('runtime.capability.release', {
      slotId,
      ownerRunId: holderRunId,
      leaseId: holderLease.id,
      force: true,
    });
  }
  location.hash = `#slot/${slotId}?activity=info`;
  socket.close();
}
