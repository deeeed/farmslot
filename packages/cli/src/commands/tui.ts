import type { Command } from 'commander';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description(
      'Interactive operator TUI (fleet, backlog, runs, roadmap/map, decisions/decide, recovery/fix, prepare/prep)',
    )
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
      // Ink only mounts after connect resolves, so its in-App `connecting…`
      // line can't cover the connect wait itself. Acknowledge on stderr up front
      // so a slow/unreachable gateway doesn't leave the TUI silent.
      const notifyTty = process.stderr.isTTY ?? false;
      if (notifyTty) process.stderr.write(`connecting to ${target.url}…`);
      try {
        const connection = await client.connect();
        if (notifyTty) process.stderr.write('\r\x1b[K');
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
        if (notifyTty) process.stderr.write('\r\x1b[K');
        emit.fail(err);
      }
    });
}
