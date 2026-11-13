import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REVIEW_WORKSPACE_SCRIPT } from './workspace-node.js';

export function workspaceGitFixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-workspace-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'upstream');
  const root = path.join(directory, 'managed');
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  writeFileSync(path.join(source, 'source.txt'), 'base\n');
  writeFileSync(path.join(source, '.gitignore'), 'ignored.tmp\n.agent/\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'source.txt'), 'head\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');
  const identity = {
    runId: 'review-run',
    workspaceId: randomUUID(),
    owner: 'owner',
    project: 'farm',
    machine: 'machine',
    executionNodeId: 'local',
    repositoryUrl: source,
    headSha,
    baseSha,
  };
  const workspace = path.join(root, 'runs', identity.workspaceId);
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify({
        owner: identity.owner,
        project: identity.project,
        repositoryUrl: identity.repositoryUrl,
      }),
    )
    .digest('hex');
  const cache = path.join(root, 'repositories', cacheKey);
  const execute = (
    action = 'allocate',
    changes: Record<string, unknown> = {},
    allowCancelled = false,
    extra: Record<string, unknown> = {},
  ) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          REVIEW_WORKSPACE_SCRIPT,
          JSON.stringify({
            root,
            identity: { ...identity, ...changes },
            action,
            allowCancelled,
            ...extra,
          }),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  return { directory, source, root, git, identity, workspace, cache, cacheKey, execute };
}
