// Hold only the selected private client's revocation close; never record auth payloads.
import fs from 'node:fs';

import WebSocket from 'ws';

const config = process.env.FARMSLOT_NATIVE_AUTH_CLOSE_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_AUTH_GATEWAY_PID) === process.pid) {
  const emit = WebSocket.prototype.emit;
  const close = WebSocket.prototype.close;
  let selected;
  let held;
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  WebSocket.prototype.emit = function (event, ...args) {
    if (event === 'message' && this._socket?.localPort === 18777 && fs.existsSync(config)) {
      let frame;
      try {
        frame = JSON.parse(String(args[0]));
      } catch {
        return emit.call(this, event, ...args);
      } // Other framing stays unchanged.
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (
        target.gatewayPid === process.pid &&
        frame.type === 'req' &&
        frame.method === 'auth.connect' &&
        frame.params?.clientName === target.clientName
      )
        selected = this;
    }
    return emit.call(this, event, ...args);
  };
  WebSocket.prototype.close = function (...args) {
    if (this !== selected || !fs.existsSync(config)) return close.apply(this, args);
    if (!held) {
      held = { socket: this, args };
      fs.writeFileSync(`${config}.held`, JSON.stringify({ gatewayPid: process.pid }), {
        mode: 0o600,
      });
      const deadline = Date.now() + 30000;
      const timer = setInterval(() => {
        if (!fs.existsSync(`${config}.release`) && Date.now() < deadline) return;
        clearInterval(timer);
        selected = undefined;
        close.apply(held.socket, held.args);
        fs.writeFileSync(`${config}.released`, '', { mode: 0o600 });
      }, 25);
      timer.unref();
    }
  };
}
