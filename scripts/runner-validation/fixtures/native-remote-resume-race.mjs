// Validation-only: release a remote RESUME after the gateway reads the old generation.
import fs from 'node:fs';

import WebSocket from 'ws';

const config = process.env.FARMSLOT_NATIVE_REMOTE_RESUME_RACE_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_REMOTE_RESUME_GATEWAY_PID) === process.pid) {
  const send = WebSocket.prototype.send;
  const emit = WebSocket.prototype.emit;
  const write = (suffix, value) =>
    fs.writeFileSync(`${config}.${suffix}`, JSON.stringify(value), { mode: 0o600 });
  const decode = (value) => {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    } // Other WebSocket traffic keeps its existing framing and handling.
  };
  let held;
  let timer;
  const cancellations = new Map();
  const receipts = [];
  write(`${process.pid}.loaded`, { gatewayPid: process.pid });

  const failPending = (socket, id) =>
    emit.call(
      socket,
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'res',
          id,
          ok: false,
          error: {
            code: 'PRIVATE_VALIDATION_DEFERRED',
            message: 'Private validation deferred remote native request',
          },
        }),
      ),
      false,
    );
  const deliver = () => {
    if (!held || held.sent) return;
    held.sent = true;
    // Preserve the original node connection and request bytes. Never reconnect or retry.
    send.apply(held.socket, held.args);
  };
  const finishTransportFailure = () => {
    clearInterval(timer);
    write('applied', { transportError: true });
    if (held?.cancel) failPending(held.socket, held.cancel.id);
    held = undefined;
  };

  WebSocket.prototype.send = function (...args) {
    if (!fs.existsSync(config)) return send.apply(this, args);
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    const frame = decode(args[0]);
    if (
      target.gatewayPid !== process.pid ||
      this._socket?.localPort !== target.gatewayPort ||
      frame?.type !== 'req' ||
      frame.method !== 'native.session' ||
      frame.params?.params?.sessionId !== target.sessionId ||
      frame.params.params.executionNodeId !== target.executionNodeId
    )
      return send.apply(this, args);
    if (
      frame.params.method === 'native.worker.resume' &&
      !held &&
      !fs.existsSync(`${config}.held`)
    ) {
      held = { socket: this, args, id: frame.id, sent: false };
      write('held', {
        gatewayPid: process.pid,
        executionNodeId: target.executionNodeId,
        sessionId: target.sessionId,
        commandId: frame.params.params.commandId,
        generation: frame.params.params.generation,
      });
      const deadline = Date.now() + 90000;
      timer = setInterval(() => {
        if (!held) return;
        if (held.socket.readyState !== WebSocket.OPEN || Date.now() > deadline) {
          finishTransportFailure();
          return;
        }
        // Failure cleanup can release a request even if run.cancel never arrived.
        if (fs.existsSync(`${config}.release`)) deliver();
      }, 25);
      timer.unref();
      queueMicrotask(() => failPending(this, frame.id));
      return;
    }
    if (held?.socket === this && frame.params.method === 'native.worker.cancel') {
      cancellations.set(frame.id, frame.params.params.generation);
      if (!held.sent && !held.cancel) {
        held.cancel = { id: frame.id, args };
        write('cancel-held', {
          sessionId: target.sessionId,
          generation: frame.params.params.generation,
          resumeCommandId: frame.params.params.resumeCommandId,
        });
        deliver();
        return;
      }
    }
    return send.apply(this, args);
  };

  WebSocket.prototype.emit = function (event, ...args) {
    if (held?.socket === this && event === 'message') {
      const frame = decode(args[0]);
      if (frame?.type === 'res' && frame.id === held.id) {
        clearInterval(timer);
        const info = frame.payload?.session;
        write('applied', {
          ok: frame.ok,
          sessionId: info?.id,
          generation: info?.generation,
          processPid: info?.processPid,
          processStopped: info?.processStopped,
          state: info?.state,
          errorCode: frame.error?.code,
        });
        if (held.cancel) send.apply(this, held.cancel.args);
      } else if (frame?.type === 'res' && cancellations.has(frame.id)) {
        receipts.push({
          requestedGeneration: cancellations.get(frame.id),
          ok: frame.ok,
          cancelled: frame.payload?.cancelled,
          reason: frame.payload?.reason,
          sessionId: frame.payload?.sessionId,
          generation: frame.payload?.generation,
          processStopped: frame.payload?.session?.processStopped,
          errorCode: frame.error?.code,
        });
        cancellations.delete(frame.id);
        write('cancellations', receipts);
      }
    }
    return emit.call(this, event, ...args);
  };
}
