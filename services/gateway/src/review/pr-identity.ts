import {
  adoptedPublicationTarget,
  parseGitHubPullUrl,
  parseGitHubRef,
  prNumberFromRunInput,
  type Run,
} from '@farmslot/protocol';

/** The PR a run works on. A leaf module, so the run store's change publisher can use it. */
export function reviewPRIdentity(
  run:
    | (Pick<Run, 'ticketOrPr' | 'links' | 'prWork'> &
        Partial<Pick<Run, 'flowType' | 'prNumber' | 'engineState'>>)
    | null
    | undefined,
  options: { requirePRContext?: boolean } = {},
): { repository: string; prNumber: number } | null {
  if (!run) return null;
  const adopted = adoptedPublicationTarget(run);
  if (adopted) return { repository: adopted.repository, prNumber: adopted.prNumber };
  const pr = run.prWork?.pr;
  if (pr) return { repository: pr.repo, prNumber: pr.number };
  const prLink = run.links?.find((link) => link.label.toLowerCase() === 'pr');
  const source = prLink?.url ?? run.ticketOrPr;
  const pull = parseGitHubPullUrl(source);
  if (
    options.requirePRContext &&
    !prLink &&
    !pull &&
    (!run.flowType || prNumberFromRunInput({ ...run, flowType: run.flowType }) === null)
  )
    return null;
  const ref = parseGitHubRef(source) ?? pull;
  return ref ? { repository: ref.repo, prNumber: ref.number } : null;
}
