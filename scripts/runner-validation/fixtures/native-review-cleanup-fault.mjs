// Validation-only asynchronous close failure for one private review progress watcher.
import fs from 'node:fs';
import path from 'node:path';

import { FSWatcher } from 'chokidar';

const config = process.env.FARMSLOT_NATIVE_REVIEW_CLEANUP_FAULT;
if (config && Number(process.env.FARMSLOT_NATIVE_REVIEW_CLEANUP_PID) === process.pid) {
  const progressWatchers = new WeakSet();
  const originalAdd = FSWatcher.prototype.add;
  const originalClose = FSWatcher.prototype.close;
  FSWatcher.prototype.add = function (...args) {
    // Tag the gateway call site, not runner output or task completion state.
    if (new Error().stack?.includes('/self-review/progress.')) progressWatchers.add(this);
    return originalAdd.apply(this, args);
  };
  FSWatcher.prototype.close = async function (...args) {
    let inject = false;
    if (progressWatchers.has(this) && fs.existsSync(config) && !fs.existsSync(`${config}.fired`)) {
      const target = JSON.parse(fs.readFileSync(config, 'utf8'));
      inject =
        target.gatewayPid === process.pid &&
        Object.entries(this.getWatched()).some(([dir, names]) =>
          names.some((name) => path.resolve(dir, name) === target.filePath),
        );
    }
    await originalClose.apply(this, args);
    if (inject) {
      await new Promise((resolve) => setImmediate(resolve));
      fs.writeFileSync(`${config}.fired`, JSON.stringify({ gatewayPid: process.pid }), {
        mode: 0o600,
      });
      throw new Error('Injected asynchronous native review watcher close failure');
    }
  };
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
}
