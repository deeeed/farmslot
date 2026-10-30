import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';
import { GitHubHttpError } from '../../integrations/github-errors.js';

import {
  assertPrepareCommitsPublished,
  assertPublishedPrepareBranchContained,
  findUnmergedSlotWork,
} from './unmerged-work.js';
import {
  bash,
  BRANCH,
  commit,
  git,
  slotRepo,
  squashAndPrune,
} from './unmerged-work.test-support.js';

test('a HEAD that publication pushed to origin is not unpushed work', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('release verifies a published HEAD without upstream or a current tracking ref', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', 'origin', BRANCH);
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(repo, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`);
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal(git(repo, 'for-each-ref', '--format=%(upstream)', `refs/heads/${BRANCH}`), '');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  commit(repo, 'unpublished.txt');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('release retains configured fork publication when its fetch refspec excludes the branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);
  git(repo, 'config', 'remote.fork.fetch', '+refs/heads/main:refs/remotes/fork/main');
  git(repo, 'update-ref', '-d', `refs/remotes/fork/${BRANCH}`);
  assert.equal(
    git(repo, 'for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${BRANCH}`),
    '',
  );
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
  git(repo, 'push', '-q', 'fork', '--delete', BRANCH);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('release accepts HEAD contained in the actual remote tip without moving the checkout', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', 'origin', BRANCH);
  const head = git(repo, 'rev-parse', 'HEAD');
  const bare = git(repo, 'remote', 'get-url', 'origin');
  const peer = path.join(repo, '..', 'peer');
  git(path.dirname(repo), 'clone', '-q', '--branch', BRANCH, bare, peer);
  git(peer, 'config', 'user.email', 'test@example.com');
  git(peer, 'config', 'user.name', 'Test');
  git(peer, 'config', 'commit.gpgsign', 'false');
  commit(peer, 'remote-follow-up.txt');
  git(peer, 'push', '-q', 'origin', BRANCH);
  git(repo, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('an absent never-published branch and a local-only upstream retain genuine unpushed work', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
  git(repo, 'branch', 'local-copy', 'HEAD');
  git(repo, 'branch', '--set-upstream-to=local-copy', BRANCH);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('prepare fetches the published HEAD branch outside a single-branch clone refspec', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  commit(repo, 'second-published.txt');
  git(repo, 'push', '-q', 'origin', BRANCH);
  git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  git(repo, 'update-ref', '-d', `refs/remotes/origin/${BRANCH}`);
  const original = git(repo, 'rev-parse', 'HEAD');
  await assertPrepareCommitsPublished(vars, 'next-run', bash);
  assert.equal(git(repo, 'rev-parse', `refs/remotes/origin/${BRANCH}`), original);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), original);
  commit(repo, 'unpublished-follow-up.txt');
  await assert.rejects(assertPrepareCommitsPublished(vars, BRANCH, bash), /unpushed commits/);
});

test('a slot without origin is judged by the fork remote its branch was pushed to', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork', 'org']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('a commit after the published head is still refused as unpushed', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork', 'org']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);
  commit(repo, 'follow-up.txt');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('dirty files on a published branch are still refused', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'edited\n');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('dirty files are refused even after the branch was deleted from the remote', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'edited after merge\n');

  // The deletion drops the tracking ref too; without the edit this would be allowed.
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files + unpushed commits');
});

test('dirty files are refused when push config names a remote the publish never used', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin', 'fork']);
  git(repo, 'config', 'remote.pushDefault', 'fork');
  // Publication pushes to origin explicitly; fork never sees the branch.
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'follow-up edit\n');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('the merged-branch probe asks the remote the publish pushed to, not push config', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin', 'fork']);
  git(repo, 'config', `branch.${BRANCH}.pushRemote`, 'fork');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  commit(repo, 'follow-up.txt');

  // fork has no such branch, but origin (where the publish went) still does.
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('unpushed work is allowed to go once its branch is deleted from the remote', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  commit(repo, 'squashed-away.txt');
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('unpushed work stays protected when its remote cannot be asked', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);
  commit(repo, 'follow-up.txt');
  git(repo, 'remote', 'set-url', 'fork', path.join(repo, 'missing.git'));

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('owned task and observability scaffolding does not block a published slot', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  mkdirSync(path.join(repo, '.task/qa'), { recursive: true });
  writeFileSync(path.join(repo, '.task/qa/TASK.md'), 'completed task');
  mkdirSync(path.join(repo, '.agent/.observability'), { recursive: true });
  writeFileSync(path.join(repo, '.agent/.observability/hooks.jsonl'), '{}');
  symlinkSync('.agent/.observability', path.join(repo, '.observability'));
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
  writeFileSync(path.join(repo, 'new-feature.ts'), 'user work');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('configured namespaces with spaces are owned but adjacent user paths are protected', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const project = { task_dir: 'support/tasks with spaces', paths: { runtime_dir: '.runtime' } };
  mkdirSync(path.join(repo, project.task_dir), { recursive: true });
  writeFileSync(path.join(repo, project.task_dir, 'TASK.md'), 'scaffold');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash, project), null);
  mkdirSync(path.join(repo, 'support/tasks with spaces-extra'));
  writeFileSync(path.join(repo, 'support/tasks with spaces-extra/user.md'), 'user work');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash, project), 'dirty files');
});

test('tracked edits inside a reserved namespace remain protected', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  mkdirSync(path.join(repo, '.task'));
  commit(repo, '.task/tracked.md');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, '.task/tracked.md'), 'user edit');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('prepare refuses two unpublished worker commits and names them without moving refs', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const first = git(repo, 'rev-parse', '--short', 'HEAD');
  commit(repo, 'second-worker.txt');
  const second = git(repo, 'rev-parse', '--short', 'HEAD');
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(assertPrepareCommitsPublished(vars, BRANCH, bash), (error: Error) => {
    assert.match(error.message, /unpushed commits/);
    assert.ok(error.message.includes(first));
    assert.ok(error.message.includes(second));
    assert.match(error.message, /Push or preserve them before retrying/);
    return true;
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'rev-parse', BRANCH), head);
});

test('prepare protects an unpublished requested branch even when HEAD is on main', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const branchHead = git(repo, 'rev-parse', BRANCH);
  git(repo, 'checkout', '-q', 'main');
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPrepareCommitsPublished(vars, BRANCH, bash),
    /refs\/heads\/.*unpushed commits/,
  );
  assert.equal(git(repo, 'rev-parse', BRANCH), branchHead);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('prepare refreshes remote refs and allows commits published from another checkout', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const author = path.join(repo, '..', 'author');
  git(repo, 'clone', '-q', repo, author);
  git(author, 'remote', 'set-url', 'origin', git(repo, 'remote', 'get-url', 'origin'));
  git(author, 'push', '-q', 'origin', BRANCH);
  assert.equal(git(repo, 'log', '--oneline', 'HEAD', '--not', '--remotes').split('\n').length, 1);
  await assertPrepareCommitsPublished(vars, BRANCH, bash);
  assert.equal(git(repo, 'log', '--oneline', 'HEAD', '--not', '--remotes'), '');
  await assertPrepareCommitsPublished(vars, 'new-run-branch', bash);
});

test('prepare fails closed when a remote cannot be refreshed', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', 'origin', BRANCH);
  git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing.git'));
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPrepareCommitsPublished(vars, BRANCH, bash),
    /Cannot verify remote commits.*branches untouched/,
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('prepare retries a fetch that lost a remote ref to a concurrent fetch in the shared repo', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', 'origin', BRANCH);
  // Another checkout published main; this repo's tracking ref has not seen it yet.
  const behind = git(repo, 'rev-parse', 'origin/main');
  const published = git(repo, 'commit-tree', 'HEAD^{tree}', '-p', behind, '-m', 'published');
  git(repo, 'push', '-q', 'origin', `${published}:refs/heads/main`);
  git(repo, 'update-ref', 'refs/remotes/origin/main', behind);
  // A slot sharing this repository fetches at the same time and holds the ref.
  const lock = path.join(repo, '.git/refs/remotes/origin/main.lock');
  writeFileSync(lock, '');
  const fetches: string[] = [];
  await assertPrepareCommitsPublished(vars, BRANCH, async (slot, command) => {
    const result = await bash(slot, command);
    if (command.includes(' fetch --all ')) {
      fetches.push(result.stderr);
      rmSync(lock, { force: true });
    }
    return result;
  });
  assert.equal(fetches.length, 2);
  assert.match(fetches[0]!, /cannot lock ref 'refs\/remotes\/origin\/main'/);
  assert.equal(git(repo, 'rev-parse', 'origin/main'), published);
});

test('prepare refuses a ref race that outlasts its retries and other fetch failures at once', async () => {
  const vars = { slotId: 'macpro-echobridge-3', remoteRepo: '/slot' } as SlotVars;
  const race =
    "error: cannot lock ref 'refs/remotes/origin/main': is at 92c802b8 but expected a7310937\n" +
    ' ! a7310937..92c802b8  main       -> origin/main  (unable to update local ref)';
  for (const [stderr, attempts] of [
    [race, 3],
    ['fatal: unable to access the remote', 1],
  ] as const) {
    let fetches = 0;
    await assert.rejects(
      assertPrepareCommitsPublished(vars, BRANCH, async (_slot, command) => {
        if (!command.includes(' fetch --all ')) return { stdout: '', stderr: '', exitCode: 0 };
        fetches++;
        return { stdout: '', stderr, exitCode: 1 };
      }),
      /Cannot verify remote commits.*branches untouched/,
    );
    assert.equal(fetches, attempts);
  }
});

test('prepare refuses an unreadable commit graph rather than assuming no work', async (t) => {
  const { vars } = slotRepo(t, ['origin']);
  const exec: typeof bash = async (slot, command) =>
    command.includes(' log ')
      ? { stdout: '', stderr: 'fatal: unreadable commit graph', exitCode: 128 }
      : bash(slot, command);
  await assert.rejects(
    assertPrepareCommitsPublished(vars, BRANCH, exec),
    /Cannot verify commits.*unreadable commit graph/,
  );
});

test('prepare can reuse detached parked work while protecting its saved branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const saved = git(repo, 'rev-parse', BRANCH);
  git(repo, 'checkout', '--detach', '-q', 'HEAD');
  await assertPrepareCommitsPublished(vars, 'next-run', bash);
  await assert.rejects(assertPrepareCommitsPublished(vars, BRANCH, bash), /unpushed commits/);
  assert.equal(git(repo, 'rev-parse', BRANCH), saved);
  git(repo, 'branch', '-D', BRANCH);
  await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), /unpushed commits/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), saved);
});

test('prepare retains published tips after remote deletion and still refuses later unpublished work', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const published = git(repo, 'rev-parse', BRANCH);
  const origin = git(repo, 'remote', 'get-url', 'origin');
  // GitHub deletes the merged branch independently of this slot's refs.
  git(origin, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  git(repo, 'config', 'fetch.prune', 'true');
  await assertPrepareCommitsPublished(vars, 'next-run', bash);
  assert.equal(git(repo, 'rev-parse', `origin/${BRANCH}`), published);
  commit(repo, 'unpublished-after-merge.txt');
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), /unpushed commits/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('prepare accepts a squash-merged patch after the deleted branch was pruned', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const merged = squashAndPrune(repo);
  assert.match(git(repo, 'cherry', 'origin/main', 'HEAD'), /^- /);

  await assertPrepareCommitsPublished(vars, 'next-run', bash);

  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
  assert.equal(git(repo, 'rev-parse', BRANCH), merged.headSha);
});

test('prepare still refuses new unpublished work after a pruned squash merge', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  squashAndPrune(repo);
  commit(repo, 'unpublished-after-squash.txt');
  const head = git(repo, 'rev-parse', 'HEAD');

  await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), (error: Error) => {
    assert.match(error.message, /unpushed commits/);
    assert.ok(error.message.includes(head));
    return true;
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

for (const file of ['fix.txt', 'untracked-notes.txt']) {
  test(`prepare preserves dirty ${file} on an otherwise merged checkout`, async (t) => {
    const { repo, vars } = slotRepo(t, ['origin']);
    const merged = squashAndPrune(repo);
    writeFileSync(path.join(repo, file), 'operator work\n');

    await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), /dirty files/);

    assert.equal(readFileSync(path.join(repo, file), 'utf8'), 'operator work\n');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
  });
}

test('prepare ignores configured untracked scaffolding but keeps adjacent user files', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  squashAndPrune(repo);
  const projectJson = { task_dir: 'support/tasks with spaces', paths: { runtime_dir: '.runtime' } };
  mkdirSync(path.join(repo, projectJson.task_dir), { recursive: true });
  writeFileSync(path.join(repo, projectJson.task_dir, 'TASK.md'), 'managed scaffold');
  await assertPrepareCommitsPublished(vars, 'next-run', bash, { projectJson });

  mkdirSync(path.join(repo, 'support/tasks with spaces-extra'));
  writeFileSync(path.join(repo, 'support/tasks with spaces-extra/user.md'), 'operator work');
  await assert.rejects(
    assertPrepareCommitsPublished(vars, 'next-run', bash, { projectJson }),
    /dirty files/,
  );
});

test('prepare checks patch equivalence against the configured default branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'branch', 'release', 'main');
  const merged = squashAndPrune(repo, 'release');

  await assertPrepareCommitsPublished(vars, 'next-run', bash, { defaultBranch: 'release' });
  await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), /unpushed commits/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
});

test('merged tips do not hide unpublished work beyond the five displayed commits', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const unpublished = git(repo, 'rev-parse', 'HEAD');
  const merged: string[] = [];
  for (let index = 0; index < 5; index++) {
    commit(repo, `published-${index}.txt`);
    merged.push(git(repo, 'rev-parse', 'HEAD'));
  }
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'cherry-pick', ...merged);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', BRANCH);

  await assert.rejects(assertPrepareCommitsPublished(vars, 'next-run', bash), (error: Error) => {
    assert.ok(error.message.includes(unpublished));
    assert.ok(!error.message.includes(head));
    return true;
  });
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('prepare accepts a merged multi-commit PR whose individual patches differ from the squash', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  commit(repo, 'second-fix.txt');
  const merged = squashAndPrune(repo);
  assert.ok(
    git(repo, 'cherry', 'origin/main', 'HEAD')
      .split('\n')
      .every((line) => line.startsWith('+ ')),
  );

  await assertPrepareCommitsPublished(
    vars,
    'next-run',
    bash,
    { githubRepo: 'example/project' },
    async (repository, head) => {
      assert.equal(repository, 'example/project');
      assert.equal(head, merged.headSha);
      return [merged];
    },
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);

  writeFileSync(path.join(repo, 'fix.txt'), 'operator work\n');
  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/project' },
      async () => [merged],
    ),
    /dirty files/,
  );
  assert.equal(readFileSync(path.join(repo, 'fix.txt'), 'utf8'), 'operator work\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
});

test('merged PR evidence does not authorize unpublished commits after its head', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  commit(repo, 'second-fix.txt');
  const merged = squashAndPrune(repo);
  commit(repo, 'unpublished-after-pr.txt');
  const head = git(repo, 'rev-parse', 'HEAD');

  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/project' },
      async () => [merged],
    ),
    /unpushed commits/,
  );
  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/project' },
      async () => {
        throw new Error('GitHub unavailable');
      },
    ),
    (error: Error) => {
      assert.match(error.message, /GitHub unavailable/);
      assert.match(error.message, /has unpushed commits/);
      assert.match(error.message, /no branch was reset or deleted/);
      assert.ok(error.message.includes(head));
      return true;
    },
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('a GitHub unknown-commit response keeps the actionable unpublished-work refusal', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPrepareCommitsPublished(
      vars,
      'next-run',
      bash,
      { githubRepo: 'example/project' },
      async () => {
        throw new GitHubHttpError(422, `No commit found for SHA: ${head}`);
      },
    ),
    (error: Error) => {
      assert.match(error.message, /has unpushed commits/);
      assert.match(error.message, /no branch was reset or deleted/);
      assert.ok(error.message.includes(head));
      return true;
    },
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('merged PR proof can fetch a later head without moving the slot branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const origin = git(repo, 'remote', 'get-url', 'origin');
  const author = path.join(repo, '..', 'author');
  git(repo, 'clone', '-q', repo, author);
  git(author, 'config', 'user.email', 'test@example.com');
  git(author, 'config', 'user.name', 'Test');
  git(author, 'config', 'commit.gpgsign', 'false');
  git(author, 'remote', 'set-url', 'origin', origin);
  commit(author, 'later-pr-fix.txt');
  const merged = squashAndPrune(author);
  git(origin, 'update-ref', 'refs/pull/241/head', merged.headSha);
  git(repo, 'fetch', '-q', '--prune', 'origin');
  const before = spawnSync('git', ['cat-file', '-e', `${merged.headSha}^{commit}`], { cwd: repo });
  assert.notEqual(before.status, 0);

  await assertPrepareCommitsPublished(
    vars,
    'next-run',
    bash,
    { githubRepo: 'example/project' },
    async () => [merged],
  );

  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'rev-parse', BRANCH), head);
  assert.equal(git(repo, 'rev-parse', `${merged.headSha}^{commit}`), merged.headSha);
});

test('merged PR evidence must reach the configured target branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'branch', 'release', 'main');
  commit(repo, 'second-fix.txt');
  const merged = squashAndPrune(repo, 'release');
  for (const evidence of [merged, { ...merged, baseBranch: 'main' }]) {
    await assert.rejects(
      assertPrepareCommitsPublished(
        vars,
        'next-run',
        bash,
        { githubRepo: 'example/project' },
        async () => [evidence],
      ),
      /unpushed commits/,
    );
  }
  assert.equal(git(repo, 'rev-parse', 'HEAD'), merged.headSha);
});

test('published unique worker commits block replacement and are named without moving refs', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const first = git(repo, 'rev-parse', '--short', 'HEAD');
  commit(repo, 'second-worker.txt');
  const second = git(repo, 'rev-parse', '--short', 'HEAD');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(
    assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main'], bash),
    (error: Error) => {
      assert.match(error.message, /refused to replace published branch/);
      assert.ok(error.message.includes(first));
      assert.ok(error.message.includes(second));
      return true;
    },
  );
  assert.equal(git(repo, 'rev-parse', BRANCH), head);
  assert.equal(git(repo, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s/)[0], head);
});

test('a published branch contained in default or recorded start ref may be replaced', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const startRef = git(repo, 'rev-parse', BRANCH);
  await assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main', startRef], bash);
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '--ff-only', BRANCH);
  git(repo, 'push', '-q', 'origin', 'main');
  await assertPublishedPrepareBranchContained(vars, BRANCH, ['origin/main'], bash);
  await assert.rejects(
    assertPublishedPrepareBranchContained(vars, BRANCH, ['missing-base'], bash),
    /Cannot verify published branch/,
  );
});
