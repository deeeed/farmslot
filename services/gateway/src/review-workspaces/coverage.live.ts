import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { coverageDefinitions } from '@farmslot/agent-runtime/scripts/review-coverage.cjs';

import { materializeReviewWorkspaceTask, readReviewWorkspaceCompletion } from './task.js';
import { withReviewWorkspaceTaskFixture } from './task-fixture.test-support.js';

const exec = promisify(execFile);

test('advancing the publication branch excludes upstream-only files from current coverage', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const repo = f.run.reviewWorkspace!.checkoutPath;
    const git = async (...args: string[]) =>
      (await exec('git', ['-C', repo, ...args])).stdout.trim();
    const commit = async () => {
      await git('add', '-A');
      await git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      );
      return git('rev-parse', 'HEAD');
    };
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'message.txt'), 'base\n');
    await commit();
    await git('checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'message.txt'), 'feature\n');
    const feature = await commit();
    await git('checkout', 'main');
    await writeFile(path.join(repo, 'upstream-only.txt'), 'Unrelated upstream work\n');
    const publicationBase = await commit();
    await git('checkout', 'feature');
    Object.assign(f.subject, {
      baseSha: publicationBase,
      contributionBaseSha: publicationBase,
      headSha: feature,
    });
    f.run.repeatReviewContext = undefined;
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const manifest = JSON.parse(
      await readFile(path.join(f.task, 'inputs/instruction-manifest.json'), 'utf8'),
    );
    assert.deepEqual(manifest.reviewCoverage.scopePaths, ['message.txt']);
  });
});

test('accepted coverage is independently checked, retained and revalidated after source cleanup', async () => {
  await withReviewWorkspaceTaskFixture(async (f) => {
    const repo = f.run.reviewWorkspace!.checkoutPath;
    const git = async (...args: string[]) =>
      (await exec('git', ['-C', repo, ...args])).stdout.trim();
    const commit = async () => {
      await git('add', '-A');
      await git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'fixture',
      );
      return git('rev-parse', 'HEAD');
    };
    await git('init', '-q');
    await writeFile(path.join(repo, 'message.txt'), 'base\n');
    const base = await commit();
    await writeFile(path.join(repo, 'message.txt'), 'hello\n');
    const head = await commit();
    Object.assign(f.subject, { baseSha: base, contributionBaseSha: base, headSha: head });
    f.run.repeatReviewContext = undefined;
    await materializeReviewWorkspaceTask(f.run.id, f.subject, f.deps);
    const startedAt = new Date().toISOString();
    f.run.agentContexts = [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        slotId: null,
        runId: f.run.id,
        status: 'working',
        nativeSession: {
          sessionId: 'session',
          leaseId: 'lease',
          commandId: 'command',
          ownerPrincipalId: 'fixture-owner',
          executionNodeId: 'local',
          generation: 'generation',
          acceptedAt: startedAt,
          launchRequestedAt: startedAt,
        },
      },
    ];
    const mark = (...args: string[]) =>
      exec(path.join(f.task, 'mark'), args, {
        cwd: f.task,
        env: { ...process.env, FARMSLOT_MARK_CMD: '' },
      });
    await mark('start');
    const policy = JSON.parse(
      await readFile(path.join(f.task, 'inputs/instruction-manifest.json'), 'utf8'),
    ).reviewCoverage;
    const definitions = coverageDefinitions(f.task, policy);
    await writeFile(path.join(f.task, 'artifacts/proof.txt'), 'hello verified\n');
    await writeFile(
      path.join(f.task, 'artifacts/learnings.md'),
      'Coverage is checked independently.\n',
    );
    const result = {
      verdict: 'pass',
      recommendation: 'APPROVE',
      issues: [],
      coverage: {
        schemaVersion: 1,
        reuse: [],
        rows: definitions.map((d) =>
          d.kind === 'scope'
            ? {
                kind: d.kind,
                path: d.path,
                scope: 'Required greeting',
                justification: 'Current greeting implementation',
                sources: [d.path],
                artifacts: [],
              }
            : {
                kind: d.kind,
                unitId: d.unitId,
                stepNumber: d.stepNumber,
                outcome: 'PASS',
                evidence: 'Greeting matches the requirement',
                sources: ['message.txt'],
                artifacts: ['artifacts/proof.txt'],
              },
        ),
      },
    };
    await writeFile(
      path.join(f.task, 'artifacts/review.md'),
      `VERDICT: APPROVE\nCOMMIT: ${head}\n\nNo findings.\n`,
    );
    await writeFile(path.join(f.task, 'artifacts/review-result.json'), JSON.stringify(result));
    await mark('1');
    await mark('complete', '--mark-last');
    const accepted = await readReviewWorkspaceCompletion(f.run.id, f.deps);
    assert(accepted?.result);
    assert(
      accepted.result.artifactManifest?.some(
        (entry) => entry.path === 'artifacts/review-coverage.json' && entry.sha256,
      ),
    );

    const indexFile = path.join(f.task, 'artifacts/review-coverage.json');
    const indexBytes = await readFile(indexFile, 'utf8');
    const forged = JSON.parse(indexBytes);
    forged.rows[0].value.justification = 'Unverified claim';
    await writeFile(indexFile, JSON.stringify(forged));
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, f.deps),
      /coverage does not match/,
    );
    await writeFile(indexFile, indexBytes);
    await writeFile(path.join(f.task, 'artifacts/proof.txt'), 'proof changed after marking\n');
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, f.deps),
      /coverage does not match/,
    );
    await writeFile(path.join(f.task, 'artifacts/proof.txt'), 'hello verified\n');
    f.run.reviewResult = accepted.result;
    f.run.reviewWorkspace!.cleanedAt = new Date().toISOString();
    await rm(repo, { recursive: true });
    const replay = await readReviewWorkspaceCompletion(f.run.id, f.deps);
    assert.equal(replay?.result?.reviewSnapshot?.headSha, head);
    const viewer = path.join(f.deps.snapshotRoot(), f.run.id, 'view');
    await writeFile(path.join(viewer, 'artifacts/review-ledger.md'), 'forged after cleanup');
    await assert.rejects(
      readReviewWorkspaceCompletion(f.run.id, f.deps),
      /differs from its accepted result/,
    );
  });
});
