import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

// The production PTY module changes tmux options on import. Child-shell tests
// must never load it or invoke PTY operations.
const forbidden = (): never => {
  throw new Error('unexpected PTY operation in isolated test');
};
mock.module('./pty-stream.js', {
  namedExports: {
    onPtyExit: forbidden,
    ptyExitHandlerCountForTests: forbidden,
    subscribePty: forbidden,
    unsubscribePty: forbidden,
    unsubscribeAllPty: forbidden,
    writePty: forbidden,
    resizePty: forbidden,
    hasPty: forbidden,
    reinitTmuxSession: forbidden,
  },
});

// Cover absolute tmux binaries and shell snippets as well as PATH lookups.
for (const method of [
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
] as const) {
  const original = childProcess[method];
  mock.method(childProcess, method, (...args: unknown[]) => {
    if (
      args
        .flat()
        .some((arg) => typeof arg === 'string' && /(?:^|[\s/'"])tmux(?:$|[\s;'"|&)])/.test(arg))
    ) {
      throw new Error('unexpected tmux invocation in isolated test');
    }
    return Reflect.apply(original, childProcess, args);
  });
}
syncBuiltinESMExports();
