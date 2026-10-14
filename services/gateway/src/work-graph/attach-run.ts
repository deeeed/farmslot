import { isRecord, type Run, type RunStack } from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { ghRequest } from '../integrations/github-client.js';
import {
  readReadyGatePreparedPackage,
  verifyReadyGatePackageHash,
} from '../run-completion/ready-gate-package.js';
import { readRunProgress } from '../runners/run-progress.js';

import { readUpstreamPr } from './stack-retarget.js';

export function attachmentRefusal(code: string, message: string): never {
  throw new GatewayMethodError(`WORK_GRAPH_ATTACH_${code}`, message);
}

export interface AttachmentSource {
  headSha: string;
  upstreamSha?: string;
  upstreamPrUrl?: string;
  publicationRefreshRequired: boolean;
}

export interface AttachmentDependencies {
  source: typeof readAttachmentSource;
  progress: typeof readRunProgress;
}

/** Read the retained ref, never the borrowed checkout's current HEAD. */
async function readAttachmentSource(
  run: Run,
  stack: RunStack,
  expectedHeadSha: string,
  existing: boolean,
): Promise<AttachmentSource> {
  if (!run.slotId || !run.branch)
    attachmentRefusal('SOURCE_MISSING', 'A retained slot and branch are required.');
  const vars = await loadSlotVars(run.slotId);
  const git = async (command: string): Promise<string> => {
    const result = await execOnSlot(vars, command, { timeout: 15_000 });
    if (result.exitCode !== 0)
      attachmentRefusal('SOURCE_UNVERIFIED', 'The retained source could not be verified.');
    return result.stdout.trim();
  };
  await git(`git check-ref-format --branch ${shellQuote(run.branch)}`);
  const child = await git(
    `git rev-parse --verify ${shellQuote(`refs/heads/${run.branch}^{commit}`)}`,
  );
  if (child !== expectedHeadSha)
    attachmentRefusal('HEAD_CHANGED', 'The retained branch differs from the expected child HEAD.');
  const prepared = await readReadyGatePreparedPackage(run);
  if (prepared) {
    verifyReadyGatePackageHash(prepared);
    if (prepared.branch !== run.branch || prepared.headSha !== child)
      attachmentRefusal('PACKAGE_CHANGED', 'Refresh the source package before attachment.');
  }
  const publicationRefreshRequired = Boolean(
    prepared &&
    prepared.reviewSnapshot?.baseRef !== `origin/${stack.retargetedTo ?? stack.baseBranch}`,
  );
  if (existing) return { headSha: child, publicationRefreshRequired };

  const configured = await loadProjectVars(run.project);
  const repo = getProjectField(configured.projectJson, 'ci.repo');
  if (!repo) attachmentRefusal('REPOSITORY_UNKNOWN', 'The project has no canonical repository.');
  const origin = await git('git remote get-url origin');
  // SSH aliases select credentials, not a different GitHub repository. Let gh's
  // existing repository resolver parse the canonical locator after removing that alias.
  const canonicalOrigin = origin.replace(/^(git@github\.com)-[^:/]+:/, '$1:');
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/)/.test(canonicalOrigin))
    attachmentRefusal('REPOSITORY_MISMATCH', 'The retained origin is not the project repository.');
  const remote = await ghRequest(['repo', 'view', canonicalOrigin, '--json', 'nameWithOwner'], {
    force: true,
    signal: AbortSignal.timeout(15_000),
  });
  const identity: unknown = JSON.parse(remote.stdout);
  if (
    !isRecord(identity) ||
    typeof identity.nameWithOwner !== 'string' ||
    identity.nameWithOwner.toLowerCase() !== repo.toLowerCase()
  )
    attachmentRefusal('REPOSITORY_MISMATCH', 'The retained origin is not the project repository.');
  const upstream = await readUpstreamPr(run.project, stack.upstreamPrNumber);
  if (
    upstream.merged ||
    upstream.state !== 'open' ||
    !upstream.sameRepo ||
    upstream.headRef !== stack.baseBranch
  )
    attachmentRefusal(
      'UPSTREAM_CHANGED',
      'The declared upstream must remain open in the same repository.',
    );
  const query = new URLSearchParams({
    state: 'all',
    head: `${repo.split('/')[0]}:${run.branch}`,
    per_page: '1',
  });
  const childPrs = await ghRequest(['api', `repos/${repo}/pulls?${query}`], {
    force: true,
    signal: AbortSignal.timeout(15_000),
  });
  const published: unknown = JSON.parse(childPrs.stdout);
  if (!Array.isArray(published) || published.length)
    attachmentRefusal('ALREADY_PUBLISHED', 'Attachment requires an unpublished child branch.');
  await git(`git check-ref-format --branch ${shellQuote(stack.baseBranch)}`);
  const remoteHead = await git(
    `git ls-remote --heads origin ${shellQuote(`refs/heads/${stack.baseBranch}`)}`,
  );
  const upstreamSha = remoteHead.split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(upstreamSha))
    attachmentRefusal('UPSTREAM_MISSING', 'The pushed upstream branch is unavailable.');
  await git(`git fetch --no-tags origin ${shellQuote(upstreamSha)}`);
  await git(`git merge-base --is-ancestor ${shellQuote(upstreamSha)} ${shellQuote(child)}`);
  if (run.startRef?.resolvedSha && run.startRef.resolvedSha !== upstreamSha)
    attachmentRefusal(
      'SOURCE_CONFLICT',
      'The retained source pin does not identify this upstream.',
    );
  const rechecked = await git(
    `git ls-remote --heads origin ${shellQuote(`refs/heads/${stack.baseBranch}`)}`,
  );
  if (
    rechecked !== remoteHead ||
    (await git(`git rev-parse --verify ${shellQuote(`refs/heads/${run.branch}^{commit}`)}`)) !==
      child
  )
    attachmentRefusal('SOURCE_CHANGED', 'Source refs changed during attachment verification.');
  const finalUpstream = await readUpstreamPr(run.project, stack.upstreamPrNumber);
  if (
    finalUpstream.merged ||
    finalUpstream.state !== 'open' ||
    !finalUpstream.sameRepo ||
    finalUpstream.headRef !== stack.baseBranch
  )
    attachmentRefusal('UPSTREAM_CHANGED', 'The upstream changed during source verification.');
  return { headSha: child, upstreamSha, upstreamPrUrl: upstream.url, publicationRefreshRequired };
}

export const attachmentDependencies: AttachmentDependencies = {
  source: readAttachmentSource,
  progress: readRunProgress,
};
