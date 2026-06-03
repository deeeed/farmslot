import type { ExecResult } from '@farmslot/protocol';

import { shellQuote } from '../core/tmux.js';

const MIN_SHORT_SHA_LENGTH = 7;
const MAX_START_REF_LENGTH = 200;

export interface StartRefResolution {
  requestedRef: string;
  resolvedSha: string;
  resolvedAt: string;
}

export type StartRefExec = (
  command: string,
) => Promise<Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode'>>;

export function sanitizeStartRef(input: string): string {
  const ref = input.trim();
  if (!ref) throw new Error('startRef is required when provided');
  if (ref.length > MAX_START_REF_LENGTH) throw new Error('startRef is too long');
  if (/[\s\0-\x1f\x7f]/.test(ref))
    throw new Error('startRef must not contain whitespace or control characters');
  if (
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\^:\\]/.test(ref) ||
    ref.startsWith('-') ||
    /[;&|`$<>(){}[\]*?!'"~]/.test(ref)
  ) {
    throw new Error(`Invalid startRef syntax: ${ref}`);
  }
  if (ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) {
    throw new Error(`Invalid startRef syntax: ${ref}`);
  }
  return ref;
}

function isShaLike(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref) && ref.length >= MIN_SHORT_SHA_LENGTH;
}

function startRefCandidateRefs(ref: string, remote = 'origin'): string[] {
  if (isShaLike(ref)) return [];
  if (ref.startsWith(`refs/remotes/${remote}/`)) return [ref];
  if (ref.startsWith(`${remote}/`)) return [`refs/remotes/${ref}`];
  if (ref.startsWith('refs/heads/'))
    return [`refs/remotes/${remote}/${ref.slice('refs/heads/'.length)}`];
  if (ref.startsWith('refs/tags/')) return [];
  return [`refs/remotes/${remote}/${ref}`];
}

function shouldResolveFetchedRemoteTag(ref: string, remote = 'origin'): boolean {
  if (isShaLike(ref)) return false;
  if (ref.startsWith('refs/tags/')) return true;
  if (ref.startsWith('refs/heads/')) return false;
  if (ref.startsWith('refs/remotes/')) return false;
  if (ref.startsWith(`${remote}/`)) return false;
  return true;
}

export const __startRefResolutionTest = {
  isShaLike,
  startRefCandidateRefs,
  shouldResolveFetchedRemoteTag,
};

async function resolveFetchedRemoteTag(
  repo: string,
  exec: StartRefExec,
  requestedRef: string,
  remote: string,
): Promise<string | null> {
  const tagName = requestedRef.startsWith('refs/tags/')
    ? requestedRef.slice('refs/tags/'.length)
    : requestedRef;
  const query = `refs/tags/${tagName}^{}`;
  const peeled = await runGit(
    repo,
    exec,
    `git ls-remote --exit-code --tags ${shellQuote(remote)} ${shellQuote(query)}`,
  );
  if (peeled.exitCode === 0 && peeled.stdout.trim()) {
    return peeled.stdout.trim().split(/\s+/)[0];
  }
  const direct = await runGit(
    repo,
    exec,
    `git ls-remote --exit-code --tags ${shellQuote(remote)} ${shellQuote(`refs/tags/${tagName}`)}`,
  );
  if (direct.exitCode === 0 && direct.stdout.trim()) {
    return direct.stdout.trim().split(/\s+/)[0];
  }
  return null;
}

async function runGit(
  repo: string,
  exec: StartRefExec,
  command: string,
): Promise<Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode'>> {
  return exec(`cd ${shellQuote(repo)} && ${command}`);
}

async function fetchedRemoteTagCommitishes(
  repo: string,
  exec: StartRefExec,
  remote: string,
): Promise<string[]> {
  const tags = await runGit(repo, exec, `git ls-remote --tags ${shellQuote(remote)}`);
  if (tags.exitCode !== 0) {
    throw new Error(
      `startRef remote tag scan failed: ${tags.stderr.slice(-200) || tags.stdout.slice(-200)}`,
    );
  }
  return [
    ...new Set(
      tags.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 2 && /^refs\/tags\//.test(parts[1]))
        .map((parts) => parts[0])
        .filter(Boolean),
    ),
  ];
}

async function existingRemoteTrackingRefs(
  repo: string,
  exec: StartRefExec,
  remote: string,
): Promise<string[]> {
  const refs = await runGit(
    repo,
    exec,
    `git for-each-ref --format=${shellQuote('%(refname)')} ${shellQuote(`refs/remotes/${remote}`)}`,
  );
  if (refs.exitCode !== 0) {
    throw new Error(
      `startRef local remote ref scan failed: ${refs.stderr.slice(-200) || refs.stdout.slice(-200)}`,
    );
  }
  return refs.stdout
    .split('\n')
    .map((ref) => ref.trim())
    .filter(Boolean);
}

function remoteTrackingRefFromHeadRef(headRef: string, remote: string): string {
  return `refs/remotes/${remote}/${headRef.slice('refs/heads/'.length)}`;
}

function headRefFromRemoteTrackingRef(remoteRef: string, remote: string): string | null {
  const prefix = `refs/remotes/${remote}/`;
  if (!remoteRef.startsWith(prefix)) return null;
  return `refs/heads/${remoteRef.slice(prefix.length)}`;
}

async function remoteHeadExists(
  repo: string,
  exec: StartRefExec,
  headRef: string,
  remote: string,
): Promise<boolean> {
  const head = await runGit(
    repo,
    exec,
    `git ls-remote --exit-code --heads ${shellQuote(remote)} ${shellQuote(headRef)}`,
  );
  return head.exitCode === 0 && head.stdout.trim().length > 0;
}

async function fetchRemoteHead(
  repo: string,
  exec: StartRefExec,
  headRef: string,
  remote: string,
): Promise<string> {
  const remoteTrackingRef = remoteTrackingRefFromHeadRef(headRef, remote);
  const fetch = await runGit(
    repo,
    exec,
    `git fetch --no-tags ${shellQuote(remote)} ${shellQuote(`+${headRef}:${remoteTrackingRef}`)}`,
  );
  if (fetch.exitCode !== 0) {
    throw new Error(
      `git fetch ${remote} ${headRef} for startRef failed: ${fetch.stderr.slice(-200) || fetch.stdout.slice(-200)}`,
    );
  }
  const show = await runGit(
    repo,
    exec,
    `git show-ref --verify --hash ${shellQuote(remoteTrackingRef)}`,
  );
  if (show.exitCode !== 0 || !show.stdout.trim()) {
    throw new Error(`startRef fetched remote head did not materialize locally: ${headRef}`);
  }
  return show.stdout.trim();
}

async function fetchRemoteCommitish(
  repo: string,
  exec: StartRefExec,
  commitish: string,
  remote: string,
): Promise<void> {
  // Fetch the exact commit-ish instead of mirroring every remote branch/tag.
  // Some repositories have historical refs that differ only by case, which can
  // make an all-head refspec fail on case-insensitive filesystems. A direct
  // remote fetch still rejects local-only objects while avoiding unrelated ref
  // namespace collisions.
  const fetch = await runGit(
    repo,
    exec,
    `git fetch --no-tags ${shellQuote(remote)} ${shellQuote(commitish)}`,
  );
  if (fetch.exitCode !== 0) {
    throw new Error(
      `git fetch ${remote} ${commitish} for startRef failed: ${fetch.stderr.slice(-200) || fetch.stdout.slice(-200)}`,
    );
  }
}

async function verifyCommitish(
  repo: string,
  exec: StartRefExec,
  commitish: string,
): Promise<string> {
  const verifyArg = `${commitish}^{commit}`;
  const verify = await runGit(repo, exec, `git cat-file -e ${shellQuote(verifyArg)}`);
  if (verify.exitCode !== 0) {
    throw new Error(`startRef does not resolve to a commit: ${commitish}`);
  }
  const full = await runGit(repo, exec, `git rev-parse --verify ${shellQuote(verifyArg)}`);
  if (full.exitCode !== 0) {
    throw new Error(`startRef commit normalization failed: ${commitish}`);
  }
  return full.stdout.trim();
}

async function assertReachableFromKnownRemote(
  repo: string,
  exec: StartRefExec,
  sha: string,
  remote: string,
): Promise<void> {
  // Do not fetch every remote branch here: case-colliding refs on macOS can
  // make all-head refspecs fail even when the requested commit is valid.
  // Existing remote-tracking refs (normally origin/main plus recently used
  // branches) and advertised tag commitishes are enough to reject local-only
  // objects while still supporting release/tag-only SHAs once the exact SHA
  // has been fetched above.
  for (const ref of await existingRemoteTrackingRefs(repo, exec, remote)) {
    const contains = await runGit(
      repo,
      exec,
      `git merge-base --is-ancestor ${shellQuote(sha)} ${shellQuote(ref)}`,
    );
    if (contains.exitCode === 0) return;
  }
  for (const tagCommitish of await fetchedRemoteTagCommitishes(repo, exec, remote)) {
    const tagCommit = `${tagCommitish}^{commit}`;
    const contains = await runGit(
      repo,
      exec,
      `git merge-base --is-ancestor ${shellQuote(sha)} ${shellQuote(tagCommit)}`,
    );
    if (contains.exitCode === 0) return;
  }
  throw new Error(`startRef commit '${sha}' is not reachable from fetched ${remote} refs/tags`);
}

export async function resolveStartRefInRepo(args: {
  repo: string;
  requestedRef: string;
  exec: StartRefExec;
  remote?: string;
}): Promise<StartRefResolution> {
  const requestedRef = sanitizeStartRef(args.requestedRef);
  const remote = args.remote ?? 'origin';

  let resolvedSha: string;
  if (isShaLike(requestedRef)) {
    await fetchRemoteCommitish(args.repo, args.exec, requestedRef, remote);
    resolvedSha = await verifyCommitish(args.repo, args.exec, requestedRef);
    await assertReachableFromKnownRemote(args.repo, args.exec, resolvedSha, remote);
  } else {
    const candidates = startRefCandidateRefs(requestedRef, remote);
    const matches: Array<{ ref: string; sha: string }> = [];
    for (const candidate of candidates) {
      const headRef = headRefFromRemoteTrackingRef(candidate, remote);
      if (!headRef || !(await remoteHeadExists(args.repo, args.exec, headRef, remote))) continue;
      const sha = await fetchRemoteHead(args.repo, args.exec, headRef, remote);
      matches.push({ ref: candidate, sha });
    }
    if (shouldResolveFetchedRemoteTag(requestedRef, remote)) {
      const remoteTagSha = await resolveFetchedRemoteTag(
        args.repo,
        args.exec,
        requestedRef,
        remote,
      );
      if (remoteTagSha) {
        await fetchRemoteCommitish(args.repo, args.exec, remoteTagSha, remote);
        matches.push({
          ref: `refs/tags/${requestedRef.replace(/^refs\/tags\//, '')}`,
          sha: remoteTagSha,
        });
      }
    }
    if (matches.length === 0) {
      throw new Error(
        `startRef '${requestedRef}' was not found on fetched ${remote} branches/tags`,
      );
    }
    const uniqueShas = [...new Set(matches.map((match) => match.sha))];
    if (matches.length > 1 && uniqueShas.length > 1) {
      throw new Error(`startRef '${requestedRef}' is ambiguous between fetched remote refs/tags`);
    }
    // Multiple names that resolve to the same commit are safe: the replay base
    // is commit-addressed after this point, so branch/tag spelling no longer
    // affects the prepared workspace.
    resolvedSha = await verifyCommitish(args.repo, args.exec, uniqueShas[0]);
  }

  return {
    requestedRef,
    resolvedSha,
    resolvedAt: new Date().toISOString(),
  };
}
