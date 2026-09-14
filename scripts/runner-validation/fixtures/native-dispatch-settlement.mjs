// Private gateway only. Delay the real accepted-task persist and observe slot writes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import WebSocket from 'ws';

const config = process.env.FARMSLOT_NATIVE_SETTLEMENT_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_SETTLEMENT_PID) === process.pid) {
  const rename = fsp.rename;
  fsp.rename = async function (from, to) {
    await rename(from, to);
    if (!fs.existsSync(config)) return;
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (target.gatewayPid !== process.pid) return;
    if (String(to) === target.statusFile) {
      const data = JSON.parse(fs.readFileSync(to, 'utf8'));
      const slot = data.slots?.find((item) => item.slot === target.slotId);
      if (slot)
        fs.appendFileSync(
          `${config}.slots`,
          JSON.stringify({ phase: slot.phase, owner: slot.current_run_id }) + '\n',
          { mode: 0o600 },
        );
    }
    if (
      !String(to).endsWith('.json') ||
      !String(to).startsWith(target.runsDir + '/') ||
      fs.existsSync(`${config}.held`)
    )
      return;
    const run = JSON.parse(fs.readFileSync(to, 'utf8'));
    if (
      run.slotId !== target.slotId ||
      !run.agentContexts?.some((context) => context.nativeSession?.acceptedAt)
    )
      return;
    fs.writeFileSync(`${config}.held`, JSON.stringify({ runId: run.id }), { mode: 0o600 });
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(`${config}.release`) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    fs.writeFileSync(`${config}.resumed`, '', { mode: 0o600 });
  };
  syncBuiltinESMExports();
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data, ...args) {
    if (typeof data === 'string' && fs.existsSync(config)) {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        /* Non-JSON traffic is outside this fixture. */
      }
      const command = frame?.method === 'exec' ? frame.params?.cmd : undefined;
      if (
        typeof command === 'string' &&
        command.includes("--runner 'codex'") &&
        command.includes('--runtime-dir')
      ) {
        const installer = command.match(
          /farmslot-node\/support\/([a-f0-9]{64})\/scripts\/install-runner-observability\.mjs/,
        );
        fs.appendFileSync(
          `${config}.installers`,
          JSON.stringify({ supportHash: installer?.[1] ?? null }) + '\n',
          { mode: 0o600 },
        );
      }
    }
    return send.call(this, data, ...args);
  };
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
}
