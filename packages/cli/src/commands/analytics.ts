import type { Command } from 'commander';

import type {
  AnalyticsBackfillResult,
  AnalyticsQueryParams,
  AnalyticsQueryResult,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { isMachineMode } from '../envelope.js';
import { withProgress } from '../progress.js';

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatQuery(r: AnalyticsQueryResult): string {
  const lines: string[] = [];
  lines.push(`Pipeline analytics — ${r.matchedRuns}/${r.scannedRuns} runs`);
  lines.push(`status: ${JSON.stringify(r.byStatus)}`);
  lines.push('');
  lines.push('bottleneck (p50 / p90 / max):');
  for (const b of r.bottleneck) {
    lines.push(
      `  ${b.step.padEnd(12)} n=${String(b.stats.n).padStart(4)}  ${fmtMs(b.stats.p50).padStart(8)} ${fmtMs(b.stats.p90).padStart(8)} ${fmtMs(b.stats.max).padStart(8)}`,
    );
  }
  lines.push('');
  lines.push(
    `wall p50=${fmtMs(r.wall.p50)} p90=${fmtMs(r.wall.p90)}   idle p50=${fmtMs(r.idle.p50)} p90=${fmtMs(r.idle.p90)}`,
  );
  lines.push(`failures by step: ${JSON.stringify(r.failureByStep)}`);
  lines.push(`failures by reason: ${JSON.stringify(r.failureByReason)}`);
  lines.push(`self-review loops: ${JSON.stringify(r.selfReviewLoops.distribution)}`);
  lines.push(`ci results: ${JSON.stringify(r.ci.resultBreakdown)}`);
  lines.push(`nudges: avg=${r.nudges.avg} zeroRate=${r.nudges.zeroRate}`);
  return lines.join('\n');
}

export function registerAnalyticsCommand(program: Command): void {
  const analytics = program.command('analytics').description('Pipeline-ops analytics');

  analytics
    .command('backfill')
    .description('Seed the analytics sink from current terminal runs (one-time, idempotent)')
    .action(async (_: unknown, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      try {
        const result = await withProgress(
          'Backfilling analytics',
          () => client.call<AnalyticsBackfillResult>('analytics.backfill'),
          !isMachineMode(output),
        );
        if (output.json) output.writeJson(result);
        else
          output.write(
            `scanned=${result.scanned} written=${result.written} skipped=${result.skipped}`,
          );
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  analytics
    .command('query')
    .description('Query aggregated pipeline analytics')
    .option('--project <name>')
    .option('--host <name>')
    .option('--flow <type>')
    .option('--runner <name>')
    .option('--model <name>')
    .option('--since <iso>', 'Lower bound on record timestamp (inclusive)')
    .option('--until <iso>', 'Upper bound on record timestamp (exclusive)')
    .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
      const { client, output } = resolveContext(cmd);
      const params: AnalyticsQueryParams = {
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.flow ? { flowType: opts.flow as AnalyticsQueryParams['flowType'] } : {}),
        ...(opts.runner ? { runner: opts.runner } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      };
      try {
        const result = await withProgress(
          'Querying analytics',
          () => client.call<AnalyticsQueryResult>('analytics.query', params),
          !isMachineMode(output),
        );
        if (output.json) output.writeJson(result);
        else output.write(formatQuery(result));
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
