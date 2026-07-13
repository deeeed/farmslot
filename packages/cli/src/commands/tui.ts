import type { Command } from 'commander';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description('Interactive operator TUI (fleet, backlog, runs, recovery)')
    .action(async (_: unknown, cmd: Command) => {
      const { client, output, target } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      // Ink needs raw-mode stdin as well as a TTY stdout.
      if (emit.machine || !process.stdin.isTTY) {
        emit.fail(
          Object.assign(new Error('The TUI requires an interactive terminal.'), {
            code: 'TUI_REQUIRES_TTY',
            userAction:
              'Run `farmslot tui` from an interactive terminal, or use the typed commands (`farmslot fleet status --json`, `farmslot backlog list --json`, …) for machine access.',
          }),
        );
        return;
      }
      try {
        const connection = await client.connect();
        try {
          // Dynamic imports keep React/Ink out of every non-TUI invocation.
          const [{ render }, { App }, react] = await Promise.all([
            import('ink'),
            import('../tui/app.js'),
            import('react'),
          ]);
          const instance = render(react.createElement(App, { connection, gatewayUrl: target.url }));
          await instance.waitUntilExit();
        } finally {
          // The command owns the connection: close on every exit path
          // (q, Ctrl+C via Ink, render failure), not just the q handler.
          connection.close();
        }
      } catch (err) {
        emit.fail(err);
      }
    });
}
