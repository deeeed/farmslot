import type { Command } from 'commander';

import type {
  EventFrame,
  ScriptActionResult,
  SlotActionListResult,
  SlotActionRunResult,
  SlotCheckResult,
  SlotFixtureRefreshResult,
  SlotRefreshResult,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { formatSlotCheck } from '../formatters/slot.js';
import { withProgress } from '../progress.js';
import { resolveCurrentSlot, resolveSlotId } from '../slot-context.js';

import { resolveSlotPrepareGatewayTimeoutMs } from './slot-prepare-timeout.js';

interface PrepareOptions {
  branch?: string;
  mergeMain?: boolean;
  flowType?: string;
  app?: string;
  prepareProfile?: string;
  var?: Record<string, string>;
}

interface ReleaseOptions {
  keepWarm?: boolean;
  keepWork?: boolean;
  skipArtifacts?: boolean;
  reset?: boolean;
  killTmux?: boolean;
}

interface RefreshOptions {
  force?: boolean;
}

interface FixtureOptions {
  flowType?: string;
  app?: string;
}

interface OpenOptions {
  editor: string;
}

interface ActionListOptions {
  placement?: string;
}

/**
 * Returns the string payload of a `script.output` frame; every other event type
 * (including the structured `slot.prepare.step` / `slot.prepare.done` metadata
 * prepare emits) yields null.
 */
export function pickStreamOutput(event: EventFrame): string | null {
  if (event.event !== 'script.output') return null;
  const payload = event.payload;
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload &&
    typeof payload.data === 'string'
  ) {
    return payload.data;
  }
  return null;
}

function handleStreamEvents(event: EventFrame): void {
  const data = pickStreamOutput(event);
  if (data !== null) process.stderr.write(data);
}

function actionParams(id: string, opts: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { slotId: id };
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined && value !== false) params[key] = value;
  }
  return params;
}

function refreshFailureMessage(slotId: string, result: SlotRefreshResult): string {
  return `Refresh skipped for ${slotId}: ${result.reason ?? 'not refreshed'}`;
}

export function registerSlotCommand(program: Command): void {
  const slot = program.command('slot').description('Slot lifecycle operations');

  slot
    .command('current')
    .description('Print the slot inferred from the current working directory')
    .action((_opts: unknown, cmd: Command) => {
      const { output } = resolveContext(cmd);
      try {
        const result = resolveCurrentSlot();
        if (!result) throw new Error('Could not infer slot from current directory.');
        if (output.json) output.writeJson(result);
        else output.write(`${result.slotId}\n`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('check')
    .description('Check slot health')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const result = await withProgress(
          `Checking ${slotId}`,
          () => client.call<SlotCheckResult>('slot.check', { slotId }),
          !output.json,
        );
        if (output.json) {
          output.writeJson(result);
        } else {
          output.write(formatSlotCheck(result));
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('prepare')
    .description('Prepare slot for dispatch')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--branch <name>', 'Branch to checkout')
    .option('--merge-main', 'Merge main after checkout')
    .option('--flow-type <type>', 'Flow type')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .option(
      '--prepare-profile <name>',
      "Named prepare profile from the project's prepare.profiles (ADR-037)",
    )
    .option(
      '--var <key=value>',
      'Project-scoped var passed to preflight as FARMSLOT_VAR_<KEY> (repeatable)',
      (value: string, acc: Record<string, string>) => {
        const eq = value.indexOf('=');
        if (eq <= 0) throw new Error(`--var expects key=value, got '${value}'`);
        acc[value.slice(0, eq)] = value.slice(eq + 1);
        return acc;
      },
      {} as Record<string, string>,
    )
    .action(async (id: string | undefined, opts: PrepareOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd, {
        timeout: resolveSlotPrepareGatewayTimeoutMs(cmd.optsWithGlobals().timeout),
      });
      try {
        const slotId = resolveSlotId(id);
        const vars: Record<string, string> = opts.var ?? {};
        const params = {
          slotId,
          branch: opts.branch,
          mergeMain: opts.mergeMain,
          flowType: opts.flowType,
          app: opts.app,
          prepareProfile: opts.prepareProfile,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
        };
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.prepare', params);
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.prepare',
            params,
            handleStreamEvents,
          );
          output.write(`Prepare complete for ${slotId}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('release')
    .description('Release slot')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--keep-warm', 'Keep Metro/device running')
    .option('--keep-work', 'Keep branch and changes')
    .option('--skip-artifacts', 'Skip artifact collection')
    .option('--reset', 'Force git reset even with uncommitted work')
    .option('--kill-tmux', 'Kill tmux session after release')
    .action(async (id: string | undefined, opts: ReleaseOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const params = {
          slotId,
          keepWarm: opts.keepWarm,
          keepWork: opts.keepWork,
          skipArtifacts: opts.skipArtifacts,
          forceReset: opts.reset,
          killTmux: opts.killTmux,
        };
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.release', params);
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.release',
            params,
            handleStreamEvents,
          );
          output.write(`Release complete for ${slotId}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('refresh')
    .description('Refresh a ready slot to the project default branch without full prepare')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--force', 'Hard-reset through dirty or stale branch state')
    .action(async (id: string | undefined, opts: RefreshOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const params = { slotId, mode: opts.force ? 'force' : 'safe' };
        if (output.json) {
          const result = await client.call<SlotRefreshResult>('slot.refresh', params);
          output.writeJson(result);
          if (!result.refreshed) process.exit(1);
        } else {
          const result = await client.callWithEvents<SlotRefreshResult>(
            'slot.refresh',
            params,
            handleStreamEvents,
          );
          if (!result.refreshed) {
            output.error(refreshFailureMessage(slotId, result));
            process.exit(1);
          }
          output.write(`Refresh complete for ${slotId}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const refreshFixtures = async (id: string | undefined, opts: FixtureOptions, cmd: Command) => {
    const { client, output } = resolveContext(cmd);
    try {
      const slotId = resolveSlotId(id);
      const params = actionParams(slotId, { flowType: opts.flowType, app: opts.app });
      if (output.json) {
        const result = await client.call<SlotFixtureRefreshResult>('slot.fixtureRefresh', params);
        output.writeJson(result);
      } else {
        await client.callWithEvents<SlotFixtureRefreshResult>(
          'slot.fixtureRefresh',
          params,
          handleStreamEvents,
        );
        output.write(`Fixtures refreshed for ${slotId}\n`);
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  };

  slot
    .command('fixtures')
    .alias('fixture-refresh')
    .description('Refresh/sync project fixtures for a slot')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--flow-type <type>', 'Flow type for fixture composition')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .action(refreshFixtures);

  slot
    .command('sync')
    .description('Quick-sync project fixtures for the current slot')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--flow-type <type>', 'Flow type for fixture composition')
    .option('--app <path>', 'Project-specific app selector, e.g. apps/sherpa-voice')
    .action(refreshFixtures);

  slot
    .command('open')
    .description('Open the slot repo in a local editor')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--editor <name>', 'Editor app/CLI (cursor or vscode)', 'cursor')
    .action(async (id: string | undefined, opts: OpenOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const result = await client.call<{ opened: boolean }>('slot.openEditor', {
          slotId,
          editor: opts.editor,
        });
        if (output.json) output.writeJson(result);
        else output.write(`Opened ${slotId} in ${opts.editor}\n`);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const action = slot.command('action').description('Project-configured slot actions');

  action
    .command('list')
    .description('List project-configured actions for a slot')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .option('--placement <placement>', 'Filter by placement (slot-header or resource-panel)')
    .action(async (id: string | undefined, opts: ActionListOptions, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const result = await client.call<SlotActionListResult>(
          'slot.action.list',
          actionParams(slotId, { placement: opts.placement }),
        );
        if (output.json) {
          output.writeJson(result);
        } else if (result.actions.length === 0) {
          output.write(`No actions configured for ${slotId}\n`);
        } else {
          for (const action of result.actions) {
            output.write(`${action.id}\t${action.label}\t${action.mode}\n`);
          }
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  action
    .command('run')
    .description('Run a project-configured action for a slot')
    .argument('<actionId>', 'Action ID from `farmslot slot action list`')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .action(async (actionId: string, id: string | undefined, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        const result = await client.call<SlotActionRunResult>('slot.action.run', {
          slotId,
          actionId,
        });
        if (output.json) {
          output.writeJson(result);
          if (!result.ok) process.exit(1);
        } else {
          if (result.stdout) output.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          if (result.command) output.write(`${result.command}\n`);
          output.write(`${result.ok ? 'Action complete' : 'Action failed'} for ${slotId}\n`);
          if (result.detail) output.write(`${result.detail}\n`);
          if (!result.ok) process.exit(1);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  slot
    .command('recycle')
    .description('Recycle slot (release + prepare)')
    .argument('[id]', 'Slot ID; defaults to the slot for the current working directory')
    .action(async (id: string | undefined, _opts: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const slotId = resolveSlotId(id);
        if (output.json) {
          const result = await client.call<ScriptActionResult>('slot.recycle', { slotId });
          output.writeJson(result);
        } else {
          await client.callWithEvents<ScriptActionResult>(
            'slot.recycle',
            { slotId },
            handleStreamEvents,
          );
          output.write(`Recycle complete for ${slotId}\n`);
        }
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
