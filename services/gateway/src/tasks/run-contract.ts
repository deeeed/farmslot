// tasks/run-contract.ts — Farmslot's own TASK.md section for unattended runs.
//
// Shared checklists (Recipe Cook) leave host rules to the host: who publishes,
// what the worker does when blocked. Farmslot states them here from the run
// mode instead of relying on a farm fixture, so every project gets the same
// contract and interactive runs get none.
import type { FlowType, Run } from '@farmslot/protocol';

/** Flows whose unattended runs follow a shared checklist that leaves host rules to Farmslot. */
const RUN_CONTRACT_FLOWS: ReadonlySet<FlowType> = new Set<FlowType>(['dev', 'fix-bug']);

export type RunContractRun = Pick<Run, 'flowType' | 'mode' | 'completionPolicy'>;

/**
 * The `## Run contract` section for an autonomous dev or fix-bug run, or `null`.
 * Interactive and validation runs get none: their checklist owns pauses and pushes.
 * Artifact-only runs get none either: they never publish, and their replay
 * guardrails already say so.
 */
export function runContractSection(run: RunContractRun, taskDir: string): string | null {
  if (run.mode !== 'autonomous' || !RUN_CONTRACT_FLOWS.has(run.flowType)) return null;
  if (run.completionPolicy === 'artifact-only') return null;
  return [
    '## Run contract',
    '',
    'Farmslot runs this task unattended. These rules apply on top of CHECKLIST.md:',
    '',
    `- Never pause for input or ask a question. When blocked, run \`${taskDir}/mark blocked --reason "…"\` and stop.`,
    '- Commit the change locally with a Conventional Commit. Until Farmslot publishes the PR, never `git push` and never run a `gh pr` write: Farmslot publishes the branch and the PR after the operator approves it at the publication gate. A later Farmslot follow-up checklist, such as CI-FIX.md, may include its own push step; follow it.',
    '- Never credit or attribute the work to an AI agent in commits, PR text or code comments.',
  ].join('\n');
}
