#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const gatewayUrl = required('gateway-url');
const slotId = required('slot-id');
const peerSlotId = required('peer-slot-id');
const ownerRunId = required('owner-run-id');
const capabilityId =
  typeof args['capability-id'] === 'string' ? args['capability-id'] : 'ios-simulator';
const reportPath = path.resolve(
  typeof args.report === 'string' ? args.report : 'reports/companion-capability-lifecycle.json',
);
const peerOwnerRunId = `${ownerRunId}-peer`;
const rpc = await connectGateway(gatewayUrl);
let runFailed = false;
let runFailure;
const cleanupTargets = [];
const cleanupFailures = [];

try {
  const [catalog, peerCatalog] = await Promise.all([
    rpc.call('runtime.capability.list', { slotId }),
    rpc.call('runtime.capability.list', { slotId: peerSlotId }),
  ]);
  for (const [target, result] of [
    [slotId, catalog],
    [peerSlotId, peerCatalog],
  ]) {
    const provider = result.capabilities.find((entry) => entry.id === capabilityId);
    if (!provider) throw new Error(`${target} does not advertise ${capabilityId}`);
    if (!provider.dependencies.includes('companion-metro')) {
      throw new Error(`${target}/${capabilityId} does not declare companion-metro dependency`);
    }
  }

  const requirement = (reason) => ({ capabilityId, reason, mode: 'state' });
  const peerCleanup = { slotId: peerSlotId, ownerRunId: peerOwnerRunId };
  cleanupTargets.push(peerCleanup);
  const peerAcquire = await rpc.call('runtime.capability.acquire', {
    slotId: peerSlotId,
    capabilityId,
    ownerRunId: peerOwnerRunId,
    proofRequirement: requirement('Peer-slot isolation fixture'),
  });
  if (!peerAcquire.ok) throw new Error(`peer acquire failed: ${JSON.stringify(peerAcquire)}`);
  peerCleanup.leaseId = peerAcquire.lease.id;

  const primaryCleanup = { slotId, ownerRunId };
  cleanupTargets.push(primaryCleanup);
  const acquire = await rpc.call('runtime.capability.acquire', {
    slotId,
    capabilityId,
    ownerRunId,
    proofRequirement: requirement('On-demand Companion lifecycle fixture'),
  });
  if (!acquire.ok) throw new Error(`primary acquire failed: ${JSON.stringify(acquire)}`);
  primaryCleanup.leaseId = acquire.lease.id;
  if (!acquire.dependencyLeases.some((lease) => lease.capabilityId === 'companion-metro')) {
    throw new Error('primary acquire did not return the Metro dependency lease');
  }

  const released = await rpc.call('runtime.capability.release', {
    slotId,
    ownerRunId,
    capabilityId,
  });
  if (!released.ok) throw new Error(`primary release failed: ${JSON.stringify(released)}`);

  const peerStatus = await rpc.call('runtime.capability.status', {
    slotId: peerSlotId,
    ownerRunId: peerOwnerRunId,
  });
  if (
    !peerStatus.leases.some(
      (lease) => lease.id === peerAcquire.lease.id && lease.state === 'acquired',
    )
  ) {
    throw new Error('releasing the primary slot touched the peer slot lease');
  }

  const peerReleased = await rpc.call('runtime.capability.release', {
    slotId: peerSlotId,
    ownerRunId: peerOwnerRunId,
    capabilityId,
  });
  if (!peerReleased.ok) throw new Error(`peer release failed: ${JSON.stringify(peerReleased)}`);

  const report = {
    checkedAt: new Date().toISOString(),
    capabilityId,
    primary: { slotId, acquire, released },
    peer: { slotId: peerSlotId, acquire: peerAcquire, released: peerReleased },
    isolationVerified: true,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log('COMPANION_CAPABILITY_LIFECYCLE_PASS');
} catch (error) {
  runFailed = true;
  runFailure = error;
}
for (const cleanup of cleanupTargets) {
  try {
    const result = await rpc.call('runtime.capability.release', {
      slotId: cleanup.slotId,
      ownerRunId: cleanup.ownerRunId,
      capabilityId,
      ...(cleanup.leaseId ? { leaseId: cleanup.leaseId } : {}),
      force: true,
    });
    if (!result.ok) {
      cleanupFailures.push(
        new Error(
          result.failures.map((failure) => `${failure.capabilityId}: ${failure.reason}`).join('; '),
        ),
      );
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
}
rpc.close();
if (runFailed) {
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [runFailure, ...cleanupFailures],
      'Companion capability fixture and cleanup failed',
    );
  }
  throw runFailure;
}
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, 'Companion capability fixture cleanup failed');
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(key) {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}`);
  return value;
}

function connectGateway(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    message.ok
      ? request.resolve(message.payload ?? message.result)
      : request.reject(new Error(JSON.stringify(message.error ?? message)));
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `companion-capability-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway RPC timeout for ${method}`));
      }, 20 * 60_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  return new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('gateway connection failed')), {
      once: true,
    });
    socket.addEventListener(
      'open',
      async () => {
        try {
          await call('auth.connect', {
            clientKind: 'ui',
            clientName: 'runtime-capability-companion-smoke',
            ...(process.env.FARMSLOT_GATEWAY_TOKEN
              ? { token: process.env.FARMSLOT_GATEWAY_TOKEN }
              : {}),
            ...(process.env.FARMSLOT_GATEWAY_PASSWORD
              ? { password: process.env.FARMSLOT_GATEWAY_PASSWORD }
              : {}),
          });
          resolve({ call, close: () => socket.close() });
        } catch (error) {
          socket.close();
          reject(error);
        }
      },
      { once: true },
    );
  });
}
