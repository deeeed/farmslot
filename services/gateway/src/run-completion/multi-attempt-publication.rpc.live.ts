// Opt-in authenticated publication-package proof. No model or external service is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Methods,
  type Run,
  type RunRefreshMirrorResult,
  type RunRefreshPublishPackageResult,
} from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

import { sameHeadFixture } from './recorded-publication-evidence.test-support.js';

test(
  'authenticated refresh retains same-run multi-attempt captures and refuses a stale revision',
  { timeout: 180_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_MULTI_ATTEMPT_LIVE, '1');
    const output = process.env.FARMSLOT_MULTI_ATTEMPT_PROOF_OUT;
    assert.ok(output);
    const root = await mkdtemp('/tmp/multi-attempt-rpc-');
    const project = 'baseline-proof';
    const slotId = 'proof-slot';
    const repo = path.join(root, 'slot');
    const taskDir = path.join(root, 'projects', project, 'tasks', 'proof');
    const workerTask = path.join(repo, '.task', 'proof');
    for (const dir of ['pool', 'scripts', 'services/gateway', `projects/${project}`, 'slot', 'bin'])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated publication proof\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, '.gitignore'), '.task/\n');
    git('add', '.gitignore');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture source');
    const headSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', headSha);
    git('switch', '-qc', 'feature');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({ name: project, default_branch: 'main', hooks: {} }),
    );
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        os: process.platform,
        platform: 'cli',
        project,
        slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo, session: slotId }],
      }),
    );
    await writeFile(
      path.join(root, '.farm-status.json'),
      JSON.stringify({
        slots: [
          {
            slot: slotId,
            machine: hostname(),
            project,
            platform: 'cli',
            lifecycle: 'busy',
            phase: 'working',
            slot_epoch: 1,
          },
        ],
      }),
    );
    // The fixture owns root, credentials and WebSocket cleanup on every exit path.
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, updateRun } = await import('../runs/store.js');
    const { updateSlotStatus } = await import('../core/index.js');
    const { makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');
    const { readGateRecordedEvidenceSources } =
      await import('../run-engine/recorded-evidence-sources.js');
    const { verifyFrozenPublicationEvidence } = await import('./recorded-publication-evidence.js');
    const f =
      process.env.FARMSLOT_MULTI_ATTEMPT_BROWSER_LIVE === '1'
        ? await (
            await import('./multi-attempt-browser.live-support.js')
          ).browserPersistenceAttempts(root, repo, headSha)
        : await sameHeadFixture(t, undefined, headSha);
    await cp(f.taskDir, workerTask, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'TASK.md'), '# Disposable publication proof\n');
    await writeFile(path.join(workerTask, 'TASK.md'), '# Disposable publication proof\n');
    await writeFile(
      path.join(workerTask, 'artifacts/pr-description.md'),
      '## Summary\nA second network proof at the same source revision.\n',
    );
    const declaration = {
      version: 1,
      standalone: [{ label: 'Second network and restart', file: `${f.baselineRoot}/proof.png` }],
    };
    await writeFile(
      path.join(workerTask, 'artifacts/evidence-manifest.json'),
      JSON.stringify(declaration),
    );
    const run = createRun({
      project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'FIXTURE-PROOF',
      slotId,
      runner: 'scripted',
      model: 'fixture',
    });
    await updateSlotStatus(slotId, {
      current_run_id: run.id,
      lifecycle: 'busy',
      phase: 'working',
      slot_epoch: 1,
    });
    const old = makeReadyGatePackage({
      headSha,
      branch: 'feature',
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    const decisionId = 'proof-ready';
    updateRun(run.id, {
      taskFile: path.join(taskDir, 'TASK.md'),
      branch: 'feature',
      status: 'needs-decision',
      worktreeHeadAtDispatch: headSha,
      recordedEvidenceContractVersion: 1,
      decisions: [
        {
          id: decisionId,
          type: 'engine_human_gate',
          title: 'Ready',
          description: 'Disposable proof',
          actions: [],
          createdAt: new Date().toISOString(),
          payload: {
            kind: 'ready',
            prPackage: old,
            prNumber: null,
            repo: null,
            diffStat: old.diffStat,
            workerReport: '',
            branch: 'feature',
          },
        },
      ],
      engineState: {
        publishGate: {
          reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
          publicationTarget: 'ready',
          publicationStatus: 'not_published',
          reviews: [],
        },
      },
    });
    const mirror = await fixture.client.call<RunRefreshMirrorResult>(Methods.RUN_REFRESH_MIRROR, {
      runId: run.id,
    });
    assert.ok(mirror.ok, mirror.ok ? undefined : mirror.reason);
    const refreshed = await fixture.client.call<RunRefreshPublishPackageResult>(
      Methods.RUN_REFRESH_PUBLISH_PACKAGE,
      { runId: run.id, decisionId },
    );
    const ready = refreshed.run.decisions.find((decision) => decision.id === decisionId)?.payload;
    assert.equal(ready?.kind, 'ready');
    assert.ok(ready?.kind === 'ready' && ready.prPackage);
    const prepared = ready.prPackage;
    assert.equal(prepared.headSha, headSha);
    assert.ok(
      prepared.evidenceManifest?.some(
        (entry) => entry.path === `artifacts/${f.baselineRoot}/trace.json`,
      ),
    );
    assert.ok(prepared.selectedEvidenceKeys?.includes(`artifacts/${f.baselineRoot}/proof.png`));
    const sources = await readGateRecordedEvidenceSources(refreshed.run, prepared);
    assert.deepEqual(
      sources.map(({ input }) => input.claims?.recipeRunId),
      [f.head.claims.recipeRunId],
    );
    await verifyFrozenPublicationEvidence(
      refreshed.run,
      prepared.evidenceManifest ?? [],
      prepared.selectedEvidenceKeys ?? [],
      prepared.artifactBundle,
      headSha,
    );
    const reread = await fixture.client.call<{ run: Run }>(Methods.RUN_GET, { runId: run.id });
    assert.deepEqual(
      (await readGateRecordedEvidenceSources(reread.run, prepared)).map(
        ({ input }) => input.claims?.recipeRunId,
      ),
      [f.head.claims.recipeRunId],
    );
    const provenancePath = path.join(
      workerTask,
      'artifacts',
      f.baselineRoot,
      'product-provenance.json',
    );
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    await writeFile(provenancePath, JSON.stringify({ ...provenance, git_ref: 'b'.repeat(40) }));
    assert.equal(
      (
        await fixture.client.call<RunRefreshMirrorResult>(Methods.RUN_REFRESH_MIRROR, {
          runId: run.id,
        })
      ).ok,
      true,
    );
    await assert.rejects(
      fixture.client.call(Methods.RUN_REFRESH_PUBLISH_PACKAGE, { runId: run.id, decisionId }),
      /git_ref|selected head/,
    );
    await writeFile(
      output,
      JSON.stringify(
        {
          status: 'PASS',
          runId: run.id,
          headSha,
          authenticatedRefresh: true,
          additionalClosureFrozen: true,
          selectedVerdictOnly: true,
          retainedRpcRead: true,
          staleAttemptRefused: true,
          externalOperations: [],
          root,
          ...('browserProof' in f ? { browserProof: f.browserProof } : {}),
        },
        null,
        2,
      ) + '\n',
    );
  },
);
