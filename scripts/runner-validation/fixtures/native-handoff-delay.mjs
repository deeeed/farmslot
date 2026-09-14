// Validation-only preload. It holds exactly one private transfer request from the
// configured gateway PID/session; native credentials remain inside the socket buffer.
import fs from 'node:fs';
import net from 'node:net';

const config = process.env.FARMSLOT_NATIVE_HANDOFF_FAULT;
const originalEnd = net.Socket.prototype.end;
if (config && Number(process.env.FARMSLOT_NATIVE_HANDOFF_GATEWAY_PID) === process.pid) {
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  net.Socket.prototype.end = function (...args) {
    const data = args[0];
    if (
      typeof data !== 'string' ||
      !data.startsWith('{') ||
      !fs.existsSync(config) ||
      fs.existsSync(`${config}.blocked`)
    )
      return originalEnd.apply(this, args);
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      // Other sockets may end with partial/non-JSON application data. Pass it through.
      return originalEnd.apply(this, args);
    }
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    const request = envelope.request;
    if (
      target.gatewayPid !== process.pid ||
      request?.method !== 'native.worker.transfer' ||
      request.id !== target.sessionId
    )
      return originalEnd.apply(this, args);
    fs.writeFileSync(
      `${config}.blocked`,
      JSON.stringify({
        gatewayPid: process.pid,
        sessionId: request.id,
        generation: request.generation,
        sourceLeaseId: request.leaseId,
      }),
      { mode: 0o600 },
    );
    if (target.mode === 'reject') {
      // Fail the real transport before sending the transfer. The gateway must
      // retain its uncertain handoff and clean it through ordinary run controls.
      this.destroy(new Error('Private validation transfer connection failed'));
      return this;
    }
    let response = '';
    this.on('data', (chunk) => {
      response += String(chunk);
    });
    this.once('end', () => {
      const reply = JSON.parse(response);
      fs.writeFileSync(
        `${config}.replied`,
        JSON.stringify({
          state: reply.value?.state,
          error: reply.error,
        }),
        { mode: 0o600 },
      );
    });
    const deadline = Date.now() + 30000;
    const poll = setInterval(() => {
      if (!fs.existsSync(`${config}.release`) && Date.now() < deadline) return;
      clearInterval(poll);
      if (!this.destroyed) originalEnd.apply(this, args);
      fs.writeFileSync(`${config}.released`, '', { mode: 0o600 });
    }, 25);
    return this;
  };
}
