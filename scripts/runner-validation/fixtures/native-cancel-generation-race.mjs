// Deliver a queued RESUME after the gateway's stop snapshot but before its CANCEL.
import fs from 'node:fs';
import net from 'node:net';

import WebSocket from 'ws';

const config = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
const end = net.Socket.prototype.end;
if (config && Number(process.env.FARMSLOT_NATIVE_RESUME_GATEWAY_PID) === process.pid) {
  const emit = WebSocket.prototype.emit;
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === 'message' && fs.existsSync(config)) {
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (target.serializeClose && target.gatewayPid === process.pid) {
        let frame;
        try {
          frame = JSON.parse(String(args[0]));
        } catch {
          return emit.call(this, event, ...args);
        } // Non-JSON frames retain normal handling.
        if (
          frame.type === 'req' &&
          frame.method === 'run.resume' &&
          frame.params?.runId === target.runId
        )
          fs.writeFileSync(`${config}.resume-arrived`, JSON.stringify({ runId: target.runId }), {
            mode: 0o600,
          });
      }
    }
    return emit.call(this, event, ...args);
  };
  net.Socket.prototype.end = function (...args) {
    const data = args[0];
    if (
      typeof data !== 'string' ||
      !data.startsWith('{') ||
      !fs.existsSync(config) ||
      fs.existsSync(`${config}.cancel-held`)
    )
      return end.apply(this, args);
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return end.apply(this, args);
    } // Other protocols can end with partial data.
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (
      !target.cancelAfterResume ||
      target.gatewayPid !== process.pid ||
      envelope.request?.method !== 'native.worker.cancel' ||
      envelope.request.id !== target.sessionId
    )
      return end.apply(this, args);
    fs.writeFileSync(
      `${config}.cancel-held`,
      JSON.stringify({ generation: envelope.request.generation }),
      { mode: 0o600 },
    );
    fs.writeFileSync(`${config}.release`, '', { mode: 0o600 });
    const timer = setInterval(() => {
      if (!fs.existsSync(`${config}.applied`)) return;
      clearInterval(timer);
      end.apply(this, args);
    }, 25);
    return this;
  };
}
