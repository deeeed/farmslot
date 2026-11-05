import childProcess from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Own the dev gateway's process group so a crash cannot strand the stack offline. */
export function supervise(command, args) {
  return new Promise((resolve) => {
    let child;
    let retry;
    let stopTimer;
    let stopping;
    let delay = 1000;
    let finished = false;
    const signalGroup = (signal) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // An exited group has already released all of its children.
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(retry);
      clearTimeout(stopTimer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      resolve(code);
    };
    const stop = (signal, code) => {
      if (stopping) return;
      stopping = code;
      clearTimeout(retry);
      if (!child) return finish(code);
      signalGroup(signal);
      stopTimer = setTimeout(() => signalGroup('SIGKILL'), 5000);
    };
    const interrupt = () => stop('SIGINT', 130);
    const terminate = () => stop('SIGTERM', 143);
    const start = () => {
      const started = Date.now();
      child = childProcess.spawn(command, args, { detached: true, stdio: 'inherit' });
      child.once('error', (error) => {
        console.error(`[gateway-supervisor] Cannot launch gateway: ${error.message}`);
        finish(1);
      });
      child.once('exit', (code, signal) => {
        // Yarn/tsx descendants belong to this launch, including after the leader crashes.
        signalGroup('SIGKILL');
        child = undefined;
        if (stopping) return finish(stopping);
        if (code === 0) return finish(0);
        if (Date.now() - started >= 60000) delay = 1000;
        console.error(
          `[gateway-supervisor] Gateway exited ${signal ?? code}; restarting in ${delay}ms`,
        );
        retry = setTimeout(start, delay);
        delay = Math.min(delay * 2, 30000);
      });
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    start();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('Usage: gateway-supervisor.mjs <command> [args...]');
  process.exitCode = await supervise(command, args);
}
