// Validation-only preload. Inactive unless a private fixture explicitly pins both PIDs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const config = process.env.FARMSLOT_NATIVE_SIGNAL_FAULT;
const originalKill = process.kill;
if (config) {
  writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  process.kill = function (pid, signal) {
    if (signal !== 0 && existsSync(config) && !existsSync(`${config}.fired`)) {
      const target = JSON.parse(readFileSync(config, 'utf8'));
      if (target.hostPid === process.pid && Math.abs(pid) === target.processPid) {
        writeFileSync(`${config}.fired`, JSON.stringify({ hostPid: process.pid, pid, signal }), {
          mode: 0o600,
        });
        throw Object.assign(new Error('Injected native cleanup signal failure'), { code: 'EPERM' });
      }
    }
    return originalKill.call(process, pid, signal);
  };
}
