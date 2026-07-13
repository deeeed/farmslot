import type { Command } from 'commander';

import { type FleetStatusResult, selectSlot } from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { formatFleetStatus } from '../formatters/fleet.js';
import { withProgress } from '../progress.js';

/**
 * Event-driven watch: one persistent authenticated connection, re-render on
 * fleet.updated broadcasts — no polling loop. q or Ctrl+C exits.
 */
async function watchFleet(
  client: ReturnType<typeof resolveContext>['client'],
  output: ReturnType<typeof resolveContext>['output'],
  forceRefresh: boolean,
): Promise<void> {
  const connection = await client.connect();
  const render = (result: FleetStatusResult) => {
    output.write(`\x1b[2J\x1b[H${formatFleetStatus(result)}\nwatching — q to quit\n`);
  };
  const stdin = process.stdin;
  let onKey: ((key: Buffer) => void) | undefined;
  // Every exit path (q, socket close, render/call error) must restore the
  // terminal — a raw-mode leak leaves the shell unusable.
  const cleanup = () => {
    if (onKey) stdin.off('data', onKey);
    onKey = undefined;
    stdin.setRawMode?.(false);
    stdin.pause();
    connection.close();
  };
  let socketClosed = false;
  try {
    render(await connection.call<FleetStatusResult>('fleet.status', { forceRefresh }));
    await new Promise<void>((resolve, reject) => {
      // Render inside handlers must settle the promise on failure — an
      // exception that escapes a handler would strand raw mode forever.
      const safeRender = (result: FleetStatusResult) => {
        try {
          render(result);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      connection.onClose(() => {
        socketClosed = true;
        resolve();
      });
      connection.onEvent((event) => {
        if (event.event === 'fleet.updated') {
          const payload = event.payload as { fleet?: FleetStatusResult['fleet'] };
          if (payload?.fleet) safeRender({ fleet: payload.fleet });
        } else if (event.event === 'run.updated') {
          // Run transitions change slot task columns without a fleet event.
          connection.call<FleetStatusResult>('fleet.status').then(safeRender, reject);
        }
      });
      stdin.setRawMode?.(true);
      stdin.resume();
      onKey = (key: Buffer) => {
        const char = key.toString();
        if (char === 'q' || char === '\u0003') resolve();
      };
      stdin.on('data', onKey);
    });
  } finally {
    cleanup();
  }
  if (socketClosed) output.write('\nconnection closed — exiting watch\n');
}

export function registerFleetCommand(program: Command): void {
  const fleet = program.command('fleet').description('Fleet management');

  fleet
    .command('status')
    .description('Show fleet status')
    .option('--force-refresh', 'Force refresh from machines')
    .option('--watch', 'Keep rendering as fleet.updated events arrive (TTY only)')
    .action(async (opts: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        if (opts.watch) {
          if (emit.machine || !process.stdin.isTTY) {
            throw Object.assign(new Error('--watch requires an interactive terminal.'), {
              code: 'WATCH_REQUIRES_TTY',
              userAction:
                'Drop --watch for one-shot output, or poll `farmslot fleet status --json` from scripts.',
            });
          }
          await watchFleet(client, output, Boolean(opts.forceRefresh));
          return;
        }
        const result = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status', { forceRefresh: opts.forceRefresh }),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  const FIND_SLOT_ACTIONS: Record<string, string> = {
    FLEET_STALE: 'Re-probe the fleet first: `farmslot fleet status --force-refresh`.',
    SLOT_NOT_FOUND: 'List slot ids with `farmslot fleet status`.',
    SLOT_UNAVAILABLE: 'Pick another slot or wait: `farmslot fleet status` shows each state.',
    NO_PROJECT_SLOTS:
      'Check the project name (`farmslot config projects`) or add slots for it to a pool.',
    NO_SLOT_AVAILABLE:
      'Free a slot or check the fleet: `farmslot fleet status`. Details list each blocked slot.',
  };

  fleet
    .command('find-slot')
    .description('Pick the best free slot for a project (or validate a specific slot)')
    .option('--project <name>', 'Project to find a slot for')
    .option('--slot <slotId>', 'Validate this specific slot instead of picking one')
    .option('--raw', 'Print only the slot id (plumbing contract for scripts)')
    .action(async (opts: { project?: string; slot?: string; raw?: boolean }, cmd: Command) => {
      // Raw failure contract: empty stdout, reason on stderr, exit 1 — must
      // also cover context/profile errors thrown before the main try.
      const rawFail = (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        const action = (err as { userAction?: string }).userAction;
        process.stderr.write(`${reason}${action ? `\nNext: ${action}` : ''}\n`);
        process.exitCode = 1;
      };
      let context;
      try {
        context = resolveContext(cmd);
      } catch (err) {
        if (opts.raw) return rawFail(err);
        throw err;
      }
      const { client, output } = context;
      const emit = createEmitter(output, cmd);
      try {
        if (!opts.project && !opts.slot) {
          throw Object.assign(new Error('Either --project or --slot is required.'), {
            code: 'USAGE_ERROR',
            userAction:
              'Run `farmslot fleet find-slot --project <name>` or `farmslot fleet find-slot --slot <slotId>`.',
          });
        }
        const status = await withProgress(
          'Fetching fleet status',
          () => client.call<FleetStatusResult>('fleet.status'),
          !emit.machine,
        );
        const result = selectSlot(status.fleet, {
          project: opts.project,
          slotId: opts.slot,
        });
        if (!result.ok) {
          throw Object.assign(new Error(result.reason), {
            code: result.code,
            userAction: FIND_SLOT_ACTIONS[result.code],
            details: result.details,
          });
        }
        if (opts.raw) {
          // Raw plumbing output — find-slot.sh captures the bare id.
          process.stdout.write(`${result.slot.slot}\n`);
        } else if (emit.machine) {
          emit.ok({ slot: result.slot });
        } else {
          output.write(`${result.slot.slot}\n`);
        }
      } catch (err) {
        if (opts.raw) return rawFail(err);
        emit.fail(err);
      }
    });

  fleet
    .command('refresh')
    .description('Force refresh fleet status')
    .action(async (_: any, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const emit = createEmitter(output, cmd);
      try {
        // fleet.refresh already returns the freshly probed fleet — a second
        // forceRefresh status call would run the whole machine probe again.
        const result = await withProgress(
          'Refreshing fleet',
          () => client.call<FleetStatusResult>('fleet.refresh'),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          output.write(formatFleetStatus(result));
        }
      } catch (err) {
        emit.fail(err);
      }
    });
}
