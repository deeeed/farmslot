// tasks/stack-section.ts — the TASK.md `## Stack` section for stacked runs
// (ADR-040 stacked work). Runs that are not stacked get no section at all.
import type { Run } from '@farmslot/protocol';

export function stackSection(run: Pick<Run, 'stack'>): string | null {
  const stack = run.stack;
  if (!stack) return null;
  const upstream = stack.upstreamPrUrl ?? `PR #${stack.upstreamPrNumber}`;
  const target = stack.retargetedTo
    ? `That PR has merged, so your PR targets \`${stack.retargetedTo}\`.`
    : `Your branch starts from that PR's head and your PR targets \`${stack.baseBranch}\`.`;
  return [
    '## Stack',
    '',
    `You are on top of ${upstream} (\`${stack.baseBranch}\`). ${target} Do not change its files unless your task needs it.`,
    `Downstream: ${stack.downstream?.length ? stack.downstream.join(', ') : 'none'}.`,
  ].join('\n');
}
