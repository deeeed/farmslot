// tasks/run-contract.ts — Farmslot's own TASK.md section for unattended runs.
//
// Shared checklists (Recipe Cook) leave host rules to the host: who publishes,
// what the worker does when blocked. Farmslot states them here from the run
// mode instead of relying on a farm fixture, so every project gets the same
// contract and interactive runs get none.

/** Flows whose unattended runs follow a shared checklist that leaves host rules to Farmslot. */
const RUN_CONTRACT_FLOWS: ReadonlySet<string> = new Set(['dev', 'fix-bug']);

/**
 * The `## Run contract` section for an autonomous dev or fix-bug run, or `null`.
 * Interactive and validation runs get none: their checklist owns pauses and pushes.
 */
export function runContractSection(
  flowType: string,
  mode: string | undefined,
  taskDir: string,
): string | null {
  if (mode !== 'autonomous' || !RUN_CONTRACT_FLOWS.has(flowType)) return null;
  return [
    '## Run contract',
    '',
    'Farmslot runs this task unattended. These rules apply on top of CHECKLIST.md:',
    '',
    `- Never pause for input or ask a question. When blocked, run \`${taskDir}/mark blocked --reason "…"\` and stop.`,
    '- Commit the change locally with a Conventional Commit. Never `git push` and never run a `gh pr` write: Farmslot publishes the branch and the PR after the operator approves it at the publication gate.',
    '- Never mention Claude, AI or LLM in commits, PR text or code comments.',
  ].join('\n');
}
