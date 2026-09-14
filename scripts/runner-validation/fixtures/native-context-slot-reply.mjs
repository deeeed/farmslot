// Private gateway transport fault. Production handlers still resolve the real run.
import fs from 'node:fs';

import WebSocket from 'ws';

const config = process.env.FARMSLOT_NATIVE_CONTEXT_SLOT_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_CONTEXT_GATEWAY_PID) === process.pid) {
  const emit = WebSocket.prototype.emit;
  const send = WebSocket.prototype.send;
  const requests = new WeakMap();
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === 'message' && this._socket?.localPort === 18777 && fs.existsSync(config)) {
      let frame;
      try {
        frame = JSON.parse(String(args[0]));
      } catch {
        return emit.call(this, event, ...args);
      } // Binary or partial frames are outside this fixture.
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (
        target.gatewayPid === process.pid &&
        frame.type === 'req' &&
        ((frame.method === 'run.forSlot' && frame.params?.slotId === target.slotId) ||
          (frame.method === 'run.get' && frame.params?.runId === target.runId))
      ) {
        if (!requests.has(this)) requests.set(this, new Map());
        requests.get(this).set(frame.id, { target, method: frame.method });
      }
    }
    return emit.call(this, event, ...args);
  };
  WebSocket.prototype.send = function (data, ...args) {
    const pending = requests.get(this);
    if (!pending?.size || typeof data !== 'string') return send.call(this, data, ...args);
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return send.call(this, data, ...args);
    } // Non-JSON traffic is unchanged.
    const request = pending.get(frame.id);
    if (frame.type !== 'res' || !request) return send.call(this, data, ...args);
    pending.delete(frame.id);
    const { target, method } = request;
    const record = (phase) =>
      fs.appendFileSync(
        `${config}.${target.caseId}.events`,
        JSON.stringify({ phase, method, ok: frame.ok, runId: frame.payload?.run?.id }) + '\n',
        {
          mode: 0o600,
        },
      );
    if (method === 'run.get') {
      record('delivered');
      return send.call(this, data, ...args);
    }
    record('held');
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (!fs.existsSync(`${config}.${target.caseId}.release`) && Date.now() < deadline) return;
      clearInterval(timer);
      if (this.readyState !== WebSocket.OPEN) {
        record('disconnected');
        return;
      }
      const response =
        target.mode === 'fail'
          ? JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: false,
              error: { code: 'PRIVATE_VALIDATION', message: 'Private slot lookup failure' },
            })
          : data;
      send.call(this, response, ...args);
      record(target.mode === 'fail' ? 'failed' : 'delivered');
    }, 25);
    timer.unref();
  };
}
