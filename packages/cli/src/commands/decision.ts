// decision.ts — global pending-decision operator surface (gateway decision.*).

import type { Command } from 'commander';

import type { DecisionListResult, PendingDecision } from '@farmslot/protocol';

import { bold, cyan, dim, green, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';
import { withProgress } from '../progress.js';

function renderDecisions(decisions: PendingDecision[]): string {
  if (decisions.length === 0) return dim('no pending decisions') + '\n';
  const lines: string[] = [];
  for (const decision of decisions) {
    lines.push(`${cyan(decision.id)}  ${yellow(decision.type)}  ${bold(decision.title)}`);
    if (decision.slotId) lines.push(`  slot ${decision.slotId}`);
    if (decision.description) lines.push(`  ${dim(decision.description.slice(0, 120))}`);
    for (const action of decision.actions ?? []) {
      lines.push(`  - ${green(action.id)}  ${action.label}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function registerDecisionCommand(program: Command): void {
  const decision = program.command('decision').description('Pending human decisions (gateway RPC)');

  decision
    .command('list')
    .description('List pending decisions across the fleet')
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          'Loading decisions',
          () => ctx.client.call<DecisionListResult>('decision.list', {}),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(renderDecisions(result.decisions));
      } catch (err) {
        emit.fail(err);
      }
    });

  decision
    .command('resolve <decisionId> <actionId>')
    .description('Resolve a pending decision with an action id')
    .action(async (decisionId: string, actionId: string, _opts: unknown, cmd: Command) => {
      const ctx = resolveContext(cmd);
      const emit = createEmitter(ctx.output, cmd);
      try {
        const result = await withProgress(
          `Resolving ${decisionId}`,
          () =>
            ctx.client.call('decision.resolve', {
              decisionId,
              actionId,
            }),
          !emit.machine,
        );
        if (emit.machine) emit.ok(result);
        else ctx.output.write(`${green('Resolved')} ${cyan(decisionId)} with ${actionId}\n`);
      } catch (err) {
        emit.fail(err);
      }
    });
}
