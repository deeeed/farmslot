#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const gatewayUrl = required(args, 'gateway-url');
const slotId = required(args, 'slot-id');
const ownerRunId = required(args, 'owner-run-id');
const reportPath = path.resolve(args.report ?? 'reports/runtime-capability-smoke.json');
const verifyReleased = args['verify-browser-released'] === true;
const forceBrowserRelease = args['force-browser-release'] === true;

if (verifyReleased && forceBrowserRelease) {
  throw new Error('--verify-browser-released and --force-browser-release are mutually exclusive');
}

const rpc = await connectGateway(gatewayUrl);
try {
  const catalog = await rpc.call('runtime.capability.list', { slotId });
  const requiredProviders = [
    'android-device',
    'browser-cdp',
    'companion-metro',
    'companion-native-client-ios',
    'ios-simulator',
    'recording',
    'sandbox-gateway-ui',
  ];
  const ids = new Set(catalog.capabilities.map((entry) => entry.id));
  for (const id of requiredProviders) {
    if (!ids.has(id)) throw new Error(`runtime capability catalog is missing '${id}'`);
  }
  const unavailable = catalog.capabilities.filter(
    (entry) => entry.availability.state === 'unavailable',
  );
  if (unavailable.length === 0) {
    throw new Error('expected slot-specific unavailable providers for unconfigured native inputs');
  }
  const unavailableEntry = unavailable[0];
  const unavailableResult = await rpc.call('runtime.capability.acquire', {
    slotId,
    capabilityId: unavailableEntry.id,
    ownerRunId: `${ownerRunId}-unavailable`,
    proofRequirement: {
      capabilityId: unavailableEntry.id,
      reason: 'prove slot-specific capability availability rejection',
      mode: 'state',
    },
  });
  if (unavailableResult.ok || unavailableResult.conflict?.kind !== 'unavailable') {
    throw new Error(
      `unavailable provider was not rejected before its action ran: ${JSON.stringify(unavailableResult)}`,
    );
  }
  const invalidParameters = await rpc.call('runtime.capability.acquire', {
    slotId,
    capabilityId: 'recording',
    ownerRunId: `${ownerRunId}-invalid-parameters`,
    parameters: { format: 'vhs' },
    proofRequirement: {
      capabilityId: 'recording',
      reason: 'prove typed capability parameter rejection',
      mode: 'visual',
    },
  });
  if (invalidParameters.ok || invalidParameters.conflict?.kind !== 'invalid-request') {
    throw new Error(
      `invalid typed parameters were not rejected: ${JSON.stringify(invalidParameters)}`,
    );
  }

  let result;
  if (forceBrowserRelease) {
    const requirement = {
      capabilityId: 'browser-cdp',
      reason: 'Prove provider teardown bypasses keep-warm policy',
      mode: 'state',
    };
    const acquired = await rpc.call('runtime.capability.acquire', {
      slotId,
      capabilityId: 'browser-cdp',
      ownerRunId,
      proofRequirement: requirement,
    });
    if (!acquired.ok || acquired.lease.state !== 'acquired') {
      throw new Error(`browser force-release setup failed: ${JSON.stringify(acquired)}`);
    }
    const release = await rpc.call('runtime.capability.release', {
      slotId,
      capabilityId: 'browser-cdp',
      ownerRunId,
      force: true,
    });
    if (
      !release.ok ||
      !release.released.some((lease) => lease.id === acquired.lease.id) ||
      release.effects.length === 0
    ) {
      throw new Error(`browser force release failed: ${JSON.stringify(release)}`);
    }
    result = {
      catalog,
      unavailableResult,
      invalidParameters,
      acquired,
      release,
      verified: 'browser-provider-force-released',
    };
  } else if (verifyReleased) {
    const status = await rpc.call('runtime.capability.status', { slotId });
    const browserLeases = status.leases.filter(
      (lease) => lease.capabilityId === 'browser-cdp' && lease.owner.runId === ownerRunId,
    );
    const latest = browserLeases.at(-1);
    if (!latest || latest.state !== 'released') {
      throw new Error(`expected released browser-cdp lease, received ${latest?.state ?? 'none'}`);
    }
    if (
      browserLeases.some((lease) =>
        ['queued', 'acquiring', 'acquired', 'releasing'].includes(lease.state),
      )
    ) {
      throw new Error('browser-cdp still has an active lease for the proof owner');
    }
    result = {
      catalog,
      unavailableResult,
      invalidParameters,
      status,
      verified: 'browser-released',
    };
  } else {
    const requirement = {
      capabilityId: 'browser-cdp',
      reason: 'Visual proof of planned/acquired ownership and operator release effects',
      mode: 'visual',
    };
    const first = await rpc.call('runtime.capability.acquire', {
      slotId,
      capabilityId: 'browser-cdp',
      ownerRunId,
      proofRequirement: requirement,
    });
    if (!first.ok || first.lease.state !== 'acquired') {
      throw new Error(`browser acquisition failed: ${JSON.stringify(first)}`);
    }
    const repeated = await rpc.call('runtime.capability.acquire', {
      slotId,
      capabilityId: 'browser-cdp',
      ownerRunId,
      proofRequirement: requirement,
    });
    if (!repeated.ok || repeated.idempotent !== true || repeated.lease.id !== first.lease.id) {
      throw new Error(`browser acquisition was not idempotent: ${JSON.stringify(repeated)}`);
    }
    const conflict = await rpc.call('runtime.capability.acquire', {
      slotId,
      capabilityId: 'browser-cdp',
      ownerRunId: `${ownerRunId}-conflict`,
      proofRequirement: requirement,
    });
    if (conflict.ok || conflict.conflict?.kind !== 'lease-conflict') {
      throw new Error(`exclusive browser conflict was not reported: ${JSON.stringify(conflict)}`);
    }
    const status = await rpc.call('runtime.capability.status', { slotId });
    if (
      !status.proofPlans[ownerRunId]?.requirements.some(
        (item) => item.capabilityId === 'browser-cdp',
      )
    ) {
      throw new Error('proof plan was not durably projected before browser acquisition');
    }
    result = {
      catalog,
      unavailableResult,
      invalidParameters,
      first,
      repeated,
      conflict,
      status,
      verified: 'browser-acquired',
    };
  }

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), slotId, ownerRunId, ...result }, null, 2)}\n`,
    'utf8',
  );
  console.log('RUNTIME_CAPABILITY_GUARDS_PASS');
  if (forceBrowserRelease) console.log('RUNTIME_CAPABILITY_PROVIDER_FORCE_RELEASED');
  else if (verifyReleased) console.log('RUNTIME_CAPABILITY_RELEASED');
  else console.log('RUNTIME_CAPABILITY_SMOKE_PASS');
} finally {
  rpc.close();
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function required(values, key) {
  const value = values[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}`);
  return value;
}

function connectGateway(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `runtime-capability-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway RPC timeout for ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  return new Promise((resolve, reject) => {
    const connectTimer = setTimeout(() => reject(new Error('gateway connection timeout')), 5_000);
    ws.addEventListener('error', () => {
      clearTimeout(connectTimer);
      reject(new Error('gateway connection error'));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.ok) request.resolve(message.payload ?? message.result);
      else request.reject(new Error(JSON.stringify(message.error ?? message)));
    });
    ws.addEventListener('open', async () => {
      clearTimeout(connectTimer);
      try {
        const auth = await call('auth.connect', {
          clientKind: 'ui',
          clientName: 'runtime-capability-smoke',
          ...(process.env.FARMSLOT_GATEWAY_TOKEN
            ? { token: process.env.FARMSLOT_GATEWAY_TOKEN }
            : {}),
          ...(process.env.FARMSLOT_GATEWAY_PASSWORD
            ? { password: process.env.FARMSLOT_GATEWAY_PASSWORD }
            : {}),
        });
        if (!auth) throw new Error('gateway authentication returned no result');
        resolve({ call, close: () => ws.close() });
      } catch (error) {
        ws.close();
        reject(error);
      }
    });
  });
}
