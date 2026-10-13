import type { Command } from 'commander';

import {
  createSourceCommandClient,
  deriveSourceStatusView,
  type PreparedSourceCommand,
  type SourcePinTarget,
  type SourcesStatusParams,
  type SourcesStatusResult,
  sourceStatusParamsForTarget,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

interface SourceScopeOptions {
  run?: string;
  node?: string;
  farm?: boolean;
  ref?: string;
}

export function sourceScopeFromOptions(
  options: SourceScopeOptions,
  required = false,
): SourcePinTarget | undefined {
  const scopes: SourcePinTarget[] = [];
  if (options.run) scopes.push({ scope: 'run', targetId: options.run });
  if (options.node) scopes.push({ scope: 'node', targetId: options.node });
  if (options.farm) scopes.push({ scope: 'farm', targetId: 'farm' });
  if (scopes.length > 1 || (required && scopes.length !== 1))
    throw new Error('Select exactly one of --run, --node or --farm.');
  return scopes[0];
}

export function formatSourcesStatus(
  status: SourcesStatusResult,
  params: SourcesStatusParams = {},
): string {
  const view = deriveSourceStatusView(status, { params, actions: [] });
  if (!view.configured && !view.rows.length && !view.runSource)
    return 'Sources are not configured.';
  const lines = [
    view.configured
      ? `Sources declaration=${view.declarationRevision} pins=${view.pinRevision}`
      : 'Source authority is not configured; retained inputs are read-only.',
  ];
  if (view.runSource) lines.push(`${view.runSource.runId}: ${view.runSource.state}`);
  for (const row of view.rows) {
    lines.push(row.summary, ...row.details.map((line) => `  ${line}`));
  }
  for (const error of view.errors)
    lines.push(`  ${error.nodeId ?? error.sourceId ?? error.project ?? 'source'}: ${error.reason}`);
  return lines.join('\n');
}

export function registerSourcesCommand(program: Command): void {
  const sources = program
    .command('sources')
    .description('Inspect and select declared farm sources');
  sources
    .command('status [sourceId]')
    .option('--run <runId>', 'Inspect one run')
    .option('--node <nodeId>', 'Inspect one node')
    .action(async (sourceId: string | undefined, options: SourceScopeOptions, command: Command) => {
      const { client, output } = resolveContext(command);
      const emit = createEmitter(output, command);
      try {
        const target = sourceScopeFromOptions(options);
        const commands = createSourceCommandClient((method, params) => client.call(method, params));
        const params = sourceStatusParamsForTarget(sourceId, target);
        const result = await withProgress(
          'Loading sources',
          () => commands.status(params),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else output.write(`${formatSourcesStatus(result, params)}\n`);
      } catch (error) {
        emit.fail(error);
      }
    });
  for (const action of ['sync', 'pin', 'unpin'] as const) {
    const command = sources.command(`${action} ${action === 'sync' ? '[sourceId]' : '<sourceId>'}`);
    command.option('--node <nodeId>', 'Select one node');
    if (action !== 'sync') {
      command
        .option('--run <runId>', 'Select one unadmitted run')
        .option('--farm', 'Select the farm');
      if (action === 'pin') command.requiredOption('--ref <branch>', 'Select a pushed branch');
    }
    command.action(
      async (sourceId: string | undefined, options: SourceScopeOptions, current: Command) => {
        const { client, output } = resolveContext(current);
        const emit = createEmitter(output, current);
        let prepared: PreparedSourceCommand | undefined;
        try {
          const commands = createSourceCommandClient((method, params) =>
            client.call(method, params),
          );
          prepared =
            action === 'sync'
              ? await commands.prepareSync({
                  ...(sourceId ? { sourceId } : {}),
                  ...(options.node ? { nodeId: options.node } : {}),
                })
              : action === 'pin'
                ? await commands.preparePin({
                    sourceId: sourceId!,
                    ...sourceScopeFromOptions(options, true)!,
                    ref: options.ref!,
                  })
                : await commands.prepareUnpin({
                    sourceId: sourceId!,
                    ...sourceScopeFromOptions(options, true)!,
                  });
          const request = prepared;
          const result = await withProgress(
            `Applying source ${action}`,
            () => commands.execute(request),
            !emit.machine,
          );
          if (emit.machine) emit.ok(result);
          else output.write(`${JSON.stringify(result, null, 2)}\n`);
        } catch (error) {
          if (prepared && error instanceof Error) {
            const original = error as Error & { details?: unknown; userAction?: string };
            Object.assign(error, {
              details: { sourceCommand: prepared, gatewayDetails: original.details },
              userAction:
                original.userAction ??
                'Inspect `farmslot sources status`. If the response was lost, retry the exact sourceCommand method and params with `farmslot rpc`; keep its operation ID and revisions.',
            });
          }
          emit.fail(error);
        }
      },
    );
  }
}
