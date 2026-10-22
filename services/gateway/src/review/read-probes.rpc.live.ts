// Opt-in proof: real run.get RPC and Git reads in a disposable farm, no worker or review launch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Methods, type RunGetResult } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test(
  'concurrent run.get readers share a real slow Git evidence read',
  { timeout: 60_000 },
  async (t) => {
    assert.equal(process.env.FARMSLOT_READ_PROBES_LIVE, '1');
    const out = process.env.FARMSLOT_READ_PROBES_PROOF_OUT;
    assert.ok(out, 'retain the receipt outside the disposable farm');
    const root = await mkdtemp(path.join('/tmp', 'run-read-probes-'));
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.TMUX_TMPDIR = path.join(root, 'tmux');
    const project = 'read-probes',
      slotId = 'read-probes-slot';
    const repo = path.join(root, 'repo');
    const taskRel = 'tasks/feat/read-probe';
    const gatewayTask = path.join(root, 'projects', project, taskRel);
    const workerTask = path.join(repo, 'temp', taskRel);
    for (const dir of [
      repo,
      gatewayTask,
      path.join(workerTask, 'artifacts'),
      path.join(root, 'pool'),
      path.join(root, 'scripts'),
      path.join(root, 'services/gateway'),
      process.env.TMUX_TMPDIR,
      out,
    ])
      await mkdir(dir, { recursive: true });
    await writeFile(path.join(root, 'CLAUDE.md'), '# Disposable read probe farm\n');
    await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\nexit 1\n');
    await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
    await writeFile(
      path.join(root, 'projects', project, 'project.json'),
      JSON.stringify({
        name: project,
        task_dir: 'temp/tasks',
        hooks: {},
        review: { enabled: false },
      }),
    );
    await writeFile(
      path.join(root, 'pool/fixture.json'),
      JSON.stringify({
        machine: hostname(),
        host: 'localhost',
        ssh_user: userInfo().username,
        platform: 'cli',
        os: process.platform,
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
            lifecycle: 'held',
            phase: 'pr-watch',
            slot_epoch: 1,
            current_run_id: null,
          },
        ],
      }),
    );
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'README.md'), 'Owned read probe fixture.\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: seed read probe fixture',
    );
    const headSha = git('rev-parse', 'HEAD');
    const countFile = path.join(root, 'git-filter-reads.txt');
    const filter = path.join(root, 'slow-filter.py');
    await writeFile(
      filter,
      `import pathlib,sys,time\np=pathlib.Path(${JSON.stringify(countFile)})\nwith p.open('a') as f:f.write('read\\n')\ntime.sleep(1)\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n`,
    );
    git('config', 'filter.read-probe.clean', `python3 '${filter}'`);
    git('config', 'filter.read-probe.required', 'true');
    await writeFile(path.join(repo, '.gitattributes'), '*.png filter=read-probe\n');
    for (const directory of [gatewayTask, workerTask])
      await writeFile(path.join(directory, 'TASK.md'), '# Read-only fixture\n');
    await writeFile(path.join(workerTask, 'artifacts/evidence-manifest.json'), '{}');
    await writeFile(path.join(workerTask, 'artifacts/proof.png'), 'fixture media bytes\n');
    const fixture = await createNativeProofFixture(t, root);
    const { createRun, getRun, updateRun, persistRunNow } = await import('../runs/store.js');
    const { updateSlotStatus } = await import('../core/index.js');
    const { readReviewedInputs } = await import('./reviewed-inputs.js');
    const { makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');
    const run = createRun({
      project,
      flowType: 'dev',
      ticketOrPr: 'READ-COALESCE-FIXTURE',
      slotId,
      mode: 'interactive',
      devInteractiveProfile: 'lightweight',
      runner: 'claude',
    });
    updateRun(run.id, {
      taskFile: path.join(gatewayTask, 'TASK.md'),
      readOnly: true,
      status: 'human-gating',
    });
    await updateSlotStatus(slotId, { current_run_id: run.id });
    const inputs = await readReviewedInputs(getRun(run.id)!);
    assert.ok(inputs, 'the fixture must execute a real Git fingerprint');
    const pkg = makeReadyGatePackage({
      headSha,
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    updateRun(run.id, {
      engineState: {
        reviewedInputs: { fingerprint: inputs.fingerprint, recordedAt: new Date().toISOString() },
      },
      decisions: [
        {
          id: 'read-probe-gate',
          type: 'engine_human_gate',
          title: 'Fixture gate',
          description: '',
          createdAt: new Date().toISOString(),
          actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
          payload: {
            kind: 'ready',
            prNumber: null,
            repo: null,
            diffStat: pkg.diffStat,
            workerReport: '',
            branch: 'main',
            headSha,
            prPackage: pkg,
          },
        },
      ],
    });
    await persistRunNow(getRun(run.id)!, 'read-probe fixture');
    await writeFile(countFile, '');
    const before = getRun(run.id)!;
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fixture.client.call<RunGetResult>(Methods.RUN_GET, { runId: run.id }),
      ),
    );
    const reads = (await readFile(countFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(reads, 1, 'twenty real RPC inspections share one evidence command');
    assert.ok(responses.every((response) => response.run.id === run.id));
    assert.equal(getRun(run.id)!.engineState?.generation, before.engineState?.generation);
    assert.equal(getRun(run.id)!.reviewRoundAdmissions?.length ?? 0, 0);
    await writeFile(
      path.join(out, 'rpc-read-probes.json'),
      JSON.stringify(
        {
          rpc: Methods.RUN_GET,
          readers: responses.length,
          gitEvidenceReads: reads,
          runId: run.id,
          fixtureRoot: root,
          generationUnchanged: true,
          reviewLaunches: 0,
          productRunsOperated: 0,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
