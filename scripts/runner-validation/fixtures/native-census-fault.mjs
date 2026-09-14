// Validation-only census fault, scoped to the exact private state root.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const config = process.env.FARMSLOT_NATIVE_CENSUS_FAULT;
const role = /\/(supervisor|host)\.(?:ts|js)$/.exec(process.argv[1] ?? '')?.[1];
if (config && role) {
  fs.writeFileSync(`${config}.${process.pid}.loaded`, '', { mode: 0o600 });
  const original = childProcess.execFileSync;
  childProcess.execFileSync = function (file, args, options) {
    if (file !== 'ps' || !args?.includes('pid=,ppid=,pgid=,lstart=') || !fs.existsSync(config))
      return original.call(this, file, args, options);
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (target.root !== process.argv[2] || !(target.roles ?? ['supervisor']).includes(role))
      return original.call(this, file, args, options);
    if (target.armed && (target.persistent || !fs.existsSync(`${config}.fired`))) {
      fs.writeFileSync(`${config}.fired`, JSON.stringify({ supervisorPid: process.pid }), {
        mode: 0o600,
      });
      throw Object.assign(new Error('Injected native census timeout'), { code: 'ETIMEDOUT' });
    }
    if (target.trace)
      fs.appendFileSync(
        target.trace,
        JSON.stringify({
          pid: process.pid,
          role,
          kind: 'sync',
          at: Date.now(),
          targeted: args.includes('-p'),
        }) + '\n',
      );
    const output = original.call(this, file, args, options);
    if (
      target.observePid &&
      String(output)
        .split('\n')
        .some((line) => Number(line.trim().split(/\s+/)[0]) === target.observePid)
    )
      fs.writeFileSync(
        `${config}.observed`,
        JSON.stringify({ supervisorPid: process.pid, pid: target.observePid }),
        { mode: 0o600 },
      );
    return output;
  };
  const originalAsync = childProcess.execFile;
  childProcess.execFile = function (file, args, options, callback) {
    if (file !== 'ps' || !args?.includes('pid=,ppid=,pgid=,lstart=') || !fs.existsSync(config))
      return originalAsync.call(this, file, args, options, callback);
    const target = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (target.root !== process.argv[2] || !(target.roles ?? ['supervisor']).includes(role))
      return originalAsync.call(this, file, args, options, callback);
    if (target.ignoreTermination && !fs.existsSync(`${config}.fired`)) {
      // A real child keeps execFile's normal timeout/kill/callback semantics.
      const child = originalAsync.call(
        this,
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000); // census-timeout-fixture",
          config,
        ],
        options,
        callback,
      );
      fs.writeFileSync(
        `${config}.fired`,
        JSON.stringify({ supervisorPid: process.pid, censusPid: child.pid, startedAt: Date.now() }),
        { mode: 0o600 },
      );
      return child;
    }
    if (target.armed && (target.persistent || !fs.existsSync(`${config}.fired`))) {
      fs.writeFileSync(`${config}.fired`, JSON.stringify({ supervisorPid: process.pid }), {
        mode: 0o600,
      });
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Injected native census timeout'), { code: 'ETIMEDOUT' }),
          '',
          '',
        ),
      );
      return;
    }
    if (target.trace)
      fs.appendFileSync(
        target.trace,
        JSON.stringify({ pid: process.pid, role, kind: 'async-start', at: Date.now() }) + '\n',
      );
    return originalAsync.call(this, file, args, options, (error, output, stderr) => {
      const finish = () => {
        if (target.trace)
          fs.appendFileSync(
            target.trace,
            JSON.stringify({ pid: process.pid, role, kind: 'async-finish', at: Date.now() }) + '\n',
          );
        if (
          !error &&
          target.observePid &&
          String(output)
            .split('\n')
            .some((line) => Number(line.trim().split(/\s+/)[0]) === target.observePid)
        )
          fs.writeFileSync(
            `${config}.observed`,
            JSON.stringify({ supervisorPid: process.pid, pid: target.observePid }),
            { mode: 0o600 },
          );
        callback(error, output, stderr);
      };
      if (target.delayMs) setTimeout(finish, target.delayMs);
      else finish();
    });
  };
  // Preserve Node's structured stdout/stderr result for unrelated promisified probes.
  Object.defineProperty(
    childProcess.execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(originalAsync, promisify.custom),
  );
  syncBuiltinESMExports();
}
