// tasks/run-contract.ts — Farmslot's own TASK.md section for unattended runs.
//
// Shared checklists (Recipe Cook) leave host rules to the host: who publishes,
// what the worker does when blocked. Farmslot states them here from the run
// mode instead of relying on a farm fixture, so every project gets the same
// contract and interactive runs get none.
import type { FlowType, Run } from '@farmslot/protocol';

/** Flows whose unattended runs follow a shared checklist that leaves host rules to Farmslot. */
const RUN_CONTRACT_FLOWS: ReadonlySet<FlowType> = new Set<FlowType>(['dev', 'fix-bug']);

export type RunContractRun = Pick<Run, 'flowType' | 'mode' | 'completionPolicy'> & {
  lane?: Run['lane'];
};

/** Artifact-only comparison replays, which get the replay guardrails instead of a run contract. */
export function shouldApplyArtifactOnlyTaskPolicy(run: RunContractRun): boolean {
  return (
    run.completionPolicy === 'artifact-only' &&
    (run.flowType === 'dev' || run.flowType === 'fix-bug') &&
    run.lane === 'comparison'
  );
}

/**
 * The `## Run contract` section for an autonomous dev or fix-bug run, or `null`.
 * Interactive and validation runs get none: their checklist owns pauses and pushes.
 * Comparison replays get none either: their replay guardrails keep the diff local.
 * Other artifact-only runs never publish, but the engine still requires their
 * work committed, so their contract asks for a local commit and no push.
 */
export function runContractSection(run: RunContractRun, taskDir: string): string | null {
  if (run.mode !== 'autonomous' || !RUN_CONTRACT_FLOWS.has(run.flowType)) return null;
  if (shouldApplyArtifactOnlyTaskPolicy(run)) return null;
  return [
    '## Run contract',
    '',
    'Farmslot runs this task unattended. These rules apply on top of CHECKLIST.md:',
    '',
    `- Never pause or ask for input. Recipe, recipe-library or action-contract mismatches never block: copy the closest recipe into the task, adapt to current actions and continue. Use testnet unless the dispatch asks for mainnet; never block over it. Run \`${taskDir}/mark blocked --reason "…"\` and stop only for missing credentials, a product decision the ticket does not settle, or a farm/device failure outside the checkout.`,
    run.completionPolicy === 'artifact-only'
      ? '- Commit the change locally with a Conventional Commit. This run is artifact-only and never publishes: never `git push` and never run a `gh pr` write. The local commit and the task artifacts are its output.'
      : '- Commit the change locally with a Conventional Commit. Until Farmslot publishes the PR, never `git push` and never run a `gh pr` write: Farmslot publishes the branch and the PR after the operator approves it at the publication gate. A later Farmslot follow-up checklist, such as CI-FIX.md, may include its own push step; follow it.',
    "- Evidence must be in the run's bundle when it completes: releasing the slot copies nothing back. If you build a binary after the evidence capture, capture it again or publish it from this run.",
    '- Never credit or attribute the work to an AI agent in commits, PR text or code comments.',
  ].join('\n');
}
