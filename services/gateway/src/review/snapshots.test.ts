import assert from 'node:assert/strict';
import test from 'node:test';

import { makeVars } from '../runners/test-fixtures.js';

import {
  captureCurrentReviewSnapshot,
  parseReviewSnapshotArtifact,
  parseUntrackedFileManifest,
  preferredRemoteReviewBaseRef,
  reviewAttemptFromResult,
  reviewSnapshotIdentityText,
  tmuxListReviewWindowIdsSnippet,
} from './snapshots.js';

test('untracked manifest binds paths, modes, and blob identities into the review diff', () => {
  const emptyBlob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
  const files = parseUntrackedFileManifest(
    [
      '100644',
      emptyBlob,
      'empty file.ts',
      '100755',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'src/a.ts',
      '',
    ].join('\0'),
  );

  assert.deepEqual(files, [
    { path: 'empty file.ts', blobSha: emptyBlob, mode: '100644' },
    { path: 'src/a.ts', blobSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: '100755' },
  ]);
  const diff = reviewSnapshotIdentityText('', files);
  assert.match(diff, new RegExp(emptyBlob));
  assert.match(diff, /"empty file\.ts"/);
  assert.notEqual(
    diff,
    reviewSnapshotIdentityText('', [{ path: 'renamed.ts', blobSha: emptyBlob, mode: '100644' }]),
  );
  assert.notEqual(
    diff,
    reviewSnapshotIdentityText('', [
      { path: 'empty file.ts', blobSha: emptyBlob, mode: '100755' },
      { path: 'src/a.ts', blobSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mode: '100755' },
    ]),
  );
});

test('untracked manifest rejects truncated entries', () => {
  assert.throws(
    () => parseUntrackedFileManifest('100644\0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0'),
    /field count/i,
  );
  assert.throws(() => parseUntrackedFileManifest('100644\0'), /field count/i);
});

test('parseReviewSnapshotArtifact rejects a missing or invalid launch snapshot', () => {
  assert.equal(parseReviewSnapshotArtifact(''), null);
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({ source: 'local-git', capturedAt: '2026-08-03T00:00:00.000Z' }),
    ),
    null,
  );
  assert.equal(
    parseReviewSnapshotArtifact(
      JSON.stringify({
        source: 'local-git',
        capturedAt: '2026-08-03T00:00:00.000Z',
        headSha: 'deadbeef',
      }),
    )?.headSha,
    'deadbeef',
  );
});

test('tmuxListReviewWindowIdsSnippet lists review windows by id, not ambiguous name target', () => {
  const snippet = tmuxListReviewWindowIdsSnippet('mme-1');

  assert.match(snippet, /list-windows -t 'mme-1'/);
  assert.match(snippet, /window_id/);
  assert.match(snippet, /window_name/);
  assert.match(snippet, /review/);
  assert.doesNotMatch(snippet, /list-panes -t .*:review/);
  assert.doesNotMatch(snippet, /kill-window/);
});

test('preferredRemoteReviewBaseRef refreshes remote branches without rewriting explicit refs', () => {
  assert.equal(preferredRemoteReviewBaseRef('main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('release/1.2'), 'origin/release/1.2');
  assert.equal(preferredRemoteReviewBaseRef('origin/main'), 'origin/main');
  assert.equal(preferredRemoteReviewBaseRef('refs/heads/main'), null);
});

test('incomplete reviewer output records a skipped attempt, never a pass', () => {
  const attempt = reviewAttemptFromResult({ verdict: 'pass', issues: [], incomplete: true }, 3);
  assert.equal(attempt.verdict, 'skipped');
  assert.equal(attempt.unresolvedCount, 0);
  assert.deepEqual(attempt.artifactPaths, []);
  assert.ok(attempt.completedAt);
});

test('COLD captures the full immutable PR range; WARM uses exactly the verified prior head', async () => {
  const commands: string[] = [];
  const head = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const base = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const prior = 'cccccccccccccccccccccccccccccccccccccccc';
  const deps: NonNullable<Parameters<typeof captureCurrentReviewSnapshot>[2]> = {
    resolveContext: async () => ({ baseRef: 'origin/main', pathspecs: ['.', ':(exclude)tasks'] }),
    exec: async (_vars, command) => {
      commands.push(command);
      let stdout = '';
      if (command === 'git rev-parse HEAD') stdout = head;
      else if (command.startsWith('git merge-base') && !command.includes('--is-ancestor'))
        stdout = base;
      else if (command.includes('--abbrev-ref')) stdout = 'feature';
      else if (command.includes('--numstat')) stdout = '1\t1\tsrc/a.ts';
      else if (command.startsWith('git diff')) stdout = 'diff --git a/src/a.ts b/src/a.ts';
      return { exitCode: 0, stdout, stderr: '' };
    },
  };
  const cold = await captureCurrentReviewSnapshot(makeVars(), { mode: 'cold' }, deps);
  assert.equal(cold.snapshot.baseSha, base);
  assert.equal(cold.snapshot.headSha, head);
  assert.ok(
    commands
      .filter((command) => command.startsWith('git diff'))
      .every((command) => command.includes(base) && command.includes(head)),
  );
  assert.ok(!commands.some((command) => command.includes('ls-files')));
  commands.length = 0;
  const warm = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: prior },
    deps,
  );
  assert.equal(warm.snapshot.baseSha, prior);
  assert.equal(warm.snapshot.headSha, head);
  assert.ok(commands.some((command) => command.includes(`--is-ancestor '${prior}' '${head}'`)));
  assert.ok(
    commands
      .filter((command) => command.startsWith('git diff'))
      .every((command) => command.includes(prior) && command.includes(head)),
  );
  const invalid = await captureCurrentReviewSnapshot(
    makeVars(),
    { mode: 'warm', lastReviewedHeadSha: prior },
    {
      ...deps,
      exec: async (...args) =>
        args[1].includes('--is-ancestor')
          ? { exitCode: 1, stdout: '', stderr: '' }
          : deps.exec(...args),
    },
  );
  assert.equal(invalid.snapshot.source, 'unavailable');
  assert.match(invalid.snapshot.error ?? '', /not an ancestor/);
});
