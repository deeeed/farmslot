// Validation-only: withhold one applied worker operation reply in the selected gateway.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import './native-resume-probe-delay.mjs';
import './native-cancel-generation-race.mjs';

const config = process.env.FARMSLOT_NATIVE_RESUME_REPLY_FAULT;
const end = net.Socket.prototype.end;
if (config && Number(process.env.FARMSLOT_NATIVE_RESUME_GATEWAY_PID) === process.pid) {
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  net.Socket.prototype.end = function (...args) {
    const data = args[0];
    if (
      typeof data !== 'string' ||
      !data.startsWith('{') ||
      !fs.existsSync(config) ||
      fs.existsSync(`${config}.applied`) ||
      fs.existsSync(`${config}.held`)
    )
      return end.apply(this, args);
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return end.apply(this, args);
    } // Other protocols can end with partial application data.
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    const requestSessionId = envelope.request?.params?.sessionId ?? envelope.request?.id;
    if (
      target.gatewayPid !== process.pid ||
      envelope.request?.method !== (target.method ?? 'native.worker.resume') ||
      (target.limit !== undefined && envelope.request?.limit !== target.limit) ||
      (target.sessionId && requestSessionId !== target.sessionId)
    )
      return end.apply(this, args);
    if (target.mode === 'defer-request') {
      // Model a transport failure with the request still queued for execution.
      // Keep credentials in memory; only the operation identity is written as evidence.
      const host = JSON.parse(
        fs.readFileSync(path.join(process.env.FARMSLOT_NATIVE_STATE_DIR, 'host.json'), 'utf8'),
      );
      fs.writeFileSync(
        `${config}.held`,
        JSON.stringify({
          gatewayPid: process.pid,
          sessionId: requestSessionId,
          commandId: envelope.request.params?.commandId ?? envelope.request.commandId,
        }),
        { mode: 0o600 },
      );
      this.destroy(new Error('Private validation deferred native request'));
      const timer = setInterval(() => {
        if (!fs.existsSync(`${config}.release`)) return;
        clearInterval(timer);
        const delayed = net.createConnection(host.socket);
        let response = '';
        delayed.setEncoding('utf8');
        delayed.setTimeout(45000, () => delayed.destroy(new Error('Deferred request timed out')));
        delayed.on('data', (chunk) => {
          response += chunk;
        });
        delayed.on('error', (error) => {
          fs.writeFileSync(`${config}.applied`, JSON.stringify({ transportError: error.message }), {
            mode: 0o600,
          });
        });
        delayed.on('end', () => {
          const reply = JSON.parse(response);
          fs.writeFileSync(
            `${config}.applied`,
            JSON.stringify({
              sessionId: requestSessionId,
              commandId: envelope.request.params?.commandId,
              state: reply.value?.state,
              generation: reply.value?.generation,
              processPid: reply.value?.processPid,
              error: reply.error,
            }),
            { mode: 0o600 },
          );
        });
        delayed.on('connect', () => end.call(delayed, data));
      }, 25);
      return this;
    }
    if (target.mode === 'probe-request') {
      fs.writeFileSync(
        `${config}.held`,
        JSON.stringify({
          gatewayPid: process.pid,
          sessionId: requestSessionId,
          commandId: envelope.request.params?.commandId,
        }),
        { mode: 0o600 },
      );
      const timer = setInterval(() => {
        if (fs.existsSync(`${config}.release`)) {
          clearInterval(timer);
          return;
        }
        if (!fs.existsSync(`${config}.probe`)) return;
        clearInterval(timer);
        // Fail the awaiting client while retaining the socket solely to capture
        // the real host's eventual reply as evidence of the cancellation race.
        this.emit('error', new Error('Private validation deferred native request'));
      }, 25);
    }
    const emit = this.emit;
    const held = [];
    let response = '';
    this.emit = function (event, ...values) {
      if (event !== 'data' && event !== 'end') return emit.call(this, event, ...values);
      held.push([event, ...values]);
      if (event === 'data') response += String(values[0]);
      if (event === 'end') {
        const reply = JSON.parse(response);
        const info = reply.value?.session ?? reply.value;
        fs.writeFileSync(
          `${config}.applied`,
          JSON.stringify({
            gatewayPid: process.pid,
            method: envelope.request.method,
            sessionId: reply.value?.id ?? requestSessionId,
            commandId: reply.value?.commandId,
            accepted: reply.value?.accepted,
            generation: info?.generation,
            processPid: info?.processPid,
            processStopped: info?.processStopped,
            nativeSessionId: info?.nativeSessionId,
            state: info?.state,
            error: reply.error,
          }),
          { mode: 0o600 },
        );
        if (target.mode === 'fail-applied-reply')
          emit.call(this, 'error', new Error('Private validation deferred native request'));
      }
      return true;
    };
    const timer = setInterval(() => {
      if (!fs.existsSync(`${config}.release`)) return;
      if (target.mode === 'probe-request' && !fs.existsSync(`${config}.applied`)) return;
      clearInterval(timer);
      this.emit = emit;
      for (const [event, ...values] of held) emit.call(this, event, ...values);
      fs.writeFileSync(`${config}.released`, '', { mode: 0o600 });
    }, 25);
    return end.apply(this, args);
  };
}
