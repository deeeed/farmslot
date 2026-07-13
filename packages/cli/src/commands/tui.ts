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
      if (emit.machine) {
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
        // Dynamic imports keep React/Ink out of every non-TUI invocation.
        const [{ render }, { App }, react] = await Promise.all([
          import('ink'),
          import('../tui/app.js'),
          import('react'),
        ]);
        const instance = render(react.createElement(App, { connection, gatewayUrl: target.url }));
        await instance.waitUntilExit();
      } catch (err) {
        emit.fail(err);
      }
    });
}
