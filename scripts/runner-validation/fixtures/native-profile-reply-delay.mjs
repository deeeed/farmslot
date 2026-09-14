// Private validation only: delay one actual profile reply without changing its payload.
import fs from 'node:fs';

import WebSocket from 'ws';

import { Methods } from '@farmslot/protocol';

const config = process.env.FARMSLOT_NATIVE_PROFILE_REPLY_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_PROFILE_REPLY_PID) === process.pid) {
  fs.writeFileSync(`${config}.${process.pid}.loaded`, 'loaded\n', { mode: 0o600 });
  const pending = new WeakMap();
  const clientKinds = new WeakMap();
  const authRequests = new WeakMap();
  const emit = WebSocket.prototype.emit;
  const send = WebSocket.prototype.send;
  const decode = (value) => {
    try {
      return JSON.parse(String(value));
    } catch {
      return undefined;
    } // Other WebSocket messages are outside this JSON RPC fixture.
  };
  WebSocket.prototype.emit = function (event, ...args) {
    const frame = event === 'message' ? decode(args[0]) : undefined;
    if (frame?.type === 'req' && frame.method === Methods.AUTH_CONNECT) {
      clientKinds.set(this, frame.params?.clientKind);
      authRequests.set(this, frame.id);
    }
    if (event === 'message' && fs.existsSync(config) && !fs.existsSync(`${config}.held`)) {
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (
        target.gatewayPid === process.pid &&
        frame?.type === 'req' &&
        clientKinds.get(this) === (target.clientKind ?? 'ui') &&
        [Methods.NATIVE_PROFILE_LIST, Methods.NATIVE_PROFILE_STATUS].includes(target.method) &&
        frame.method === target.method &&
        (frame.params?.executionNodeId ?? 'local') === target.executionNodeId &&
        (!target.profileId || frame.params?.profileId === target.profileId)
      ) {
        pending.set(this, {
          requestId: frame.id,
          method: frame.method,
          requestedAt: Date.now(),
          target,
        });
      }
    }
    return emit.call(this, event, ...args);
  };
  WebSocket.prototype.send = function (...args) {
    const held = pending.get(this);
    const frame = decode(args[0]);
    if (
      frame?.type === 'res' &&
      frame.ok &&
      frame.id === authRequests.get(this) &&
      clientKinds.get(this) === 'companion'
    ) {
      fs.writeFileSync(
        `${config}.companion-ready`,
        JSON.stringify({
          at: Date.now(),
          principalId: frame.payload?.principal?.id,
          gatewayPid: process.pid,
        }),
        { mode: 0o600 },
      );
      authRequests.delete(this);
    }
    if (
      !held ||
      frame?.type !== 'res' ||
      frame.id !== held.requestId ||
      !frame.ok ||
      fs.existsSync(`${config}.held`)
    ) {
      return send.apply(this, args);
    }
    pending.delete(this);
    const started = Date.now();
    fs.writeFileSync(
      `${config}.held`,
      JSON.stringify({
        gatewayPid: process.pid,
        requestId: held.requestId,
        method: held.method,
        started,
        requestedAt: held.requestedAt,
        profileIds: frame.payload?.profiles?.map((profile) => profile.id),
      }),
      { mode: 0o600 },
    );
    const timer = setInterval(() => {
      const requested = fs.existsSync(`${config}.release`);
      if (!requested && Date.now() - started < 12000) return;
      clearInterval(timer);
      const delivered = this.readyState === WebSocket.OPEN;
      if (delivered) send.apply(this, args);
      fs.writeFileSync(
        `${config}.released`,
        JSON.stringify({ delivered, requested, elapsedMs: Date.now() - started }),
        { mode: 0o600 },
      );
    }, 20);
  };
}
