import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
// Manual gateway proof. Setup fixtures are isolated; derived task bytes are not injected.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BranchMaintenanceCheckpoint,
  BranchMaintenanceOperation,
  ReadyGatePrPackage,
  Run,
  RunGetResult,
  RunListResult,
  WorkGraphAttachRunResult,
} from '@farmslot/protocol';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import { resolveGatewayTarget } from '../../../packages/cli/src/gateway-profiles.js';
import { isRecord } from '@farmslot/protocol';
import { shellQuote as shSingleQuote } from '../../../services/gateway/src/core/tmux.js';
import { captureCurrentReviewSnapshot } from '../../../services/gateway/src/review/snapshots.js';
import {
  computeReadyGatePackageHash,
  readReadyGatePreparedPackage,
} from '../../../services/gateway/src/run-completion/ready-gate-package.js';
import { readGateRecordedEvidenceSources } from '../../../services/gateway/src/run-engine/recorded-evidence-sources.js';
import { buildCodexExecLaunch } from '../../../services/gateway/src/runners/launch-command.js';
import { makeVars } from '../../../services/gateway/src/runners/test-fixtures.js';

const source = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else if (process.argv[2] === 'attachment' || process.argv[2] === 'attachment-after-restart') {
  await proveRetainedAttachment(process.argv[2] === 'attachment-after-restart');
} else {
  execFileSync('tmux', ['-N', 'has-session']);
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'stack-base-proof-')));
  const root = path.join(scratch, 'root');
  const repo = path.join(root, 'checkout');
  const out = path.resolve(
    process.env.FARMSLOT_STACK_BASE_PROOF_OUT ?? 'temp/stack-base-proof',
    randomUUID(),
  );
  const session = `stack-base-${randomUUID()}`;
  const slotId = `stack-base-${randomUUID()}`;
  const project = 'stack-base-proof';
  const failAfterPush = process.env.FARMSLOT_STACK_BASE_PROOF_ONLY === 'pushed-terminal';
  const json = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const logs: string[] = [];
  let gateway: ChildProcess | undefined;
  let ownedSession = false;
  let env = { ...process.env };
  const stopGateway = async () => {
    if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return;
    gateway.kill('SIGTERM');
    await Promise.race([once(gateway, 'exit'), pause(3000)]);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill('SIGKILL');
      await once(gateway, 'exit');
    }
  };
  const rpc = (method: string, params: unknown) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: source, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      ),
    );
  const wait = async (
    read: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 90_000,
  ) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      assert.ok(!gateway || gateway.exitCode === null, logs.join('').slice(-2500));
      if (await read()) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
    symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
    symlinkSync(path.join(source, 'templates'), path.join(root, 'templates'), 'dir');
    symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    symlinkSync(path.join(source, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'trunk');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'common.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'test: seed common base');
    const remote = path.join(scratch, 'origin.git');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'trunk');
    git('checkout', '-b', 'feat/upstream');
    writeFileSync(path.join(repo, 'parent.txt'), 'parent\n');
    git('add', '.');
    git('commit', '-m', 'test: seed published upstream');
    const parentSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'feat/upstream');
    git('checkout', '-b', 'feat/child');
    writeFileSync(path.join(repo, 'child.txt'), 'child\n');
    git('add', '.');
    git('commit', '-m', 'test: seed child contribution');
    const childSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'feat/child');
    git('branch', 'feat/retargeted', childSha);
    git('branch', 'feat/inline', childSha);
    git('push', 'origin', 'feat/retargeted', 'feat/inline');
    writeFileSync(path.join(repo, '.git/info/exclude'), '.task/\nnode_modules/\n');
    const commonSha = git('rev-parse', parentSha + '^');
    git('branch', 'feat/merged-parent', parentSha);
    git('push', 'origin', 'feat/merged-parent');
    git('checkout', 'trunk');
    writeFileSync(path.join(repo, 'unrelated-default.txt'), 'unrelated default work\n');
    git('add', 'unrelated-default.txt');
    git('commit', '-m', 'test: unrelated default work before publication');
    const defaultAdditionSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'trunk');
    git('checkout', '-b', 'feat/merged-owned', childSha);
    git('merge', '--no-ff', 'trunk', '-m', 'test: child took unrelated default work');
    const mergedSourceSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'feat/merged-owned');
    git('checkout', 'trunk');
    git('revert', '--no-edit', defaultAdditionSha);
    git('push', 'origin', 'trunk');
    git('push', 'origin', commonSha + ':refs/heads/feat/merged-parent', '--force');

    const captured = await captureCurrentReviewSnapshot(
      makeVars({ remoteRepo: repo, host: 'localhost', machine: hostname() }),
      {
        baseRef: 'feat/upstream',
        committedBaseSha: parentSha,
        committedHeadSha: childSha,
      },
    );
    assert.equal(captured.snapshot.source, 'local-git');
    const initialCheckpoint: BranchMaintenanceCheckpoint = {
      ...captured.snapshot,
      replayBoundarySha: parentSha,
    };
    git('checkout', 'trunk');
    git('merge', '--squash', 'feat/upstream');
    git('commit', '-m', 'test: squash published upstream');
    const upstreamMergeSha = git('rev-parse', 'HEAD');
    git('push', 'origin', 'trunk');
    git('checkout', '-b', 'feat/ordinary');
    writeFileSync(path.join(repo, 'ordinary.txt'), 'ordinary child\n');
    git('add', 'ordinary.txt');
    git('commit', '-m', 'test: seed ordinary child');
    git('push', 'origin', 'feat/ordinary');
    git('checkout', 'trunk');
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Stack base proof\n');
    json(path.join(root, 'services/gateway/package.json'), { name: 'proof', version: '0.0.0' });
    const workerScript = path.join(scratch, 'maintenance-worker.mjs');
    writeFileSync(
      workerScript,
      String.raw`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';const dir=process.env.FARMSLOT_TASK_DIR;const task=fs.readFileSync(path.join(dir,'TASK.md'),'utf8');for(const phase of ['execute','push']){const command=task.split('\n').find(line=>line.startsWith('node ')&&line.includes('branch-update.mjs')&&line.includes(' '+phase+' '));assert.ok(command,'generated shared command missing');execFileSync('bash',['-eu','-c',command],{stdio:'pipe'});}fs.mkdirSync(path.join(dir,'artifacts'),{recursive:true});fs.writeFileSync(path.join(dir,'artifacts/comments-report.md'),'# Maintenance\n\nThe shared guard and leased push passed. No comment changes.\n');fs.writeFileSync(path.join(dir,'artifacts/learnings.md'),'# Maintenance contract\n\nThe generated guard reuses the pinned input; the shared push checks the exact captured child lease. Both commands passed in this attempt.\n');`,
    );
    if (failAfterPush)
      writeFileSync(workerScript, readFileSync(workerScript, 'utf8') + '\nprocess.exit(1);\n');
    const projectConfig = {
      name: project,
      task_dir: '.task',
      paths: { runtime_dir: '.task' },
      default_branch: 'trunk',
      hooks: {},
      ci: { enabled: true, repo: 'fixture/missing', checkGroups: [] },
      scripted: {
        commands: {
          maintain: { command: `node ${shSingleQuote(workerScript)}`, timeout_ms: 60_000 },
        },
      },
      monitoring: { poll_interval_min: 0.005, total_timeout_min: 5 },
    };
    json(path.join(root, 'projects', project, 'project.json'), projectConfig);
    const dispatchPrompt = path.join(
      root,
      'projects',
      project,
      'templates/prompts/worker-dispatch.md',
    );
    mkdirSync(path.dirname(dispatchPrompt), { recursive: true });
    writeFileSync(
      dispatchPrompt,
      'Read {{TASK_FILE}} and execute the configured maintenance command.\n',
    );
    for (const flow of ['pr-complete', 'update-branch']) {
      const target = path.join(root, 'projects', project, 'templates/worker', flow + '.md');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        '# Branch maintenance\n\n- [ ] Rebase onto origin/{{PUBLICATION_BASE}}\n',
      );
    }
    json(path.join(root, 'pool/local.json'), {
      schema_version: 2,
      machine: hostname(),
      host: 'localhost',
      ssh_user: userInfo().username,
      os: process.platform,
      project,
      platform: 'cli',
      slots: [
        { id: slotId, project, platform: 'cli', repo, session, enabled: true, mode: 'dispatch' },
      ],
    });
    const parentId = randomUUID();
    const retargetedId = randomUUID();
    const now = new Date().toISOString();
    const stack = {
      upstreamNodeId: 'upstream-node',
      upstreamRunId: randomUUID(),
      baseBranch: 'feat/upstream',
      upstreamPrNumber: 41,
      upstreamPrUrl: 'https://example.invalid/pull/41',
      resolvedSha: parentSha,
    };
    const baseRun = (id: string, flowType: string) => ({
      id,
      familyId: id,
      flowType,
      mode: 'autonomous',
      safetyTier: 'dangerous',
      transport: 'tmux',
      scripted: { mode: 'command', commandRef: 'maintain' },
      status: 'failed',
      project,
      ticketOrPr: 'fixture/missing#42',
      slotId,
      branch: 'feat/child',
      taskFile: null,
      createdAt: now,
      updatedAt: now,
      metrics: {
        runner: 'scripted',
        nudgeCount: 0,
        model: 'scripted',
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      steps: [
        { name: 'find-slot', status: 'done' },
        { name: 'write-task', status: 'failed' },
        ...[
          'prepare',
          'dispatch',
          'monitor',
          'review',
          'complete',
          'human-gate',
          'finalize',
          'ci-watch',
        ].map((name) => ({ name, status: 'pending' })),
      ],
      decisions: [],
      agentContexts: [],
      engineState: { generation: 0 },
      ticketData: {
        source: 'manual',
        title: 'Stack base proof',
        description: 'Verify derived branch maintenance base.',
        acceptanceCriteria: [],
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    });
    json(path.join(root, '.runs', parentId + '.json'), {
      ...baseRun(parentId, 'dev'),
      status: 'done',
      completedAt: now,
      stack,
      prNumber: 42,
      engineState: { generation: 0, publishGate: { maintainedSnapshot: initialCheckpoint } },
    });
    json(path.join(root, '.runs', retargetedId + '.json'), {
      ...baseRun(retargetedId, 'dev'),
      status: 'done',
      completedAt: now,
      branch: 'feat/retargeted',
      prNumber: 43,
      stack: { ...stack, retargetedTo: 'trunk', upstreamMergeSha },
      engineState: { generation: 0, publishGate: { maintainedSnapshot: initialCheckpoint } },
    });
    const mergedOwnerId = randomUUID();
    const mergedTask = path.join(
      root,
      'projects',
      project,
      'tasks',
      'frozen-merged-owner',
      'TASK.md',
    );
    const mergedSnapshot = await captureCurrentReviewSnapshot(
      makeVars({ remoteRepo: repo, host: 'localhost', machine: hostname() }),
      {
        baseRef: 'feat/merged-parent',
        committedBaseSha: defaultAdditionSha,
        committedHeadSha: mergedSourceSha,
      },
    );
    const mergedPackage: ReadyGatePrPackage = {
      id: 'frozen-merged-owner',
      packageHash: '',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'feat/merged-owned',
      headSha: mergedSourceSha,
      diffStat: { files: 2, additions: 2, deletions: 0 },
      reviewSnapshot: mergedSnapshot.snapshot,
      draftTitle: 'fix: merged child',
      draftBody: '',
      reviewArtifactIds: [],
      gatePolicy: {
        owner: 'human',
        dispatchMode: 'interactive',
        publishAuthority: 'human',
        reason: 'fixture',
      },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: now,
    };
    mergedPackage.packageHash = computeReadyGatePackageHash(mergedPackage);
    mkdirSync(path.dirname(mergedTask), { recursive: true });
    writeFileSync(mergedTask, '# Frozen merged publication\n');
    json(path.join(path.dirname(mergedTask), mergedPackage.artifactPath), mergedPackage);
    json(path.join(root, '.runs', mergedOwnerId + '.json'), {
      ...baseRun(mergedOwnerId, 'dev'),
      status: 'done',
      completedAt: now,
      prNumber: 46,
      branch: 'feat/merged-owned',
      taskFile: mergedTask,
      stack: { ...stack, baseBranch: 'feat/merged-parent' },
      engineState: { generation: 0, publishGate: { packageHash: mergedPackage.packageHash } },
    });
    const cases = [
      {
        id: randomUUID(),
        flow: 'pr-complete',
        branch: 'feat/child',
        parentRunId: parentId,
        expected: 'feat/upstream',
      },
      {
        id: randomUUID(),
        flow: 'update-branch',
        branch: 'feat/child',
        parentRunId: parentId,
        expected: 'feat/upstream',
      },
      {
        id: randomUUID(),
        flow: 'pr-complete',
        branch: 'feat/retargeted',
        parentRunId: retargetedId,
        expected: 'trunk',
      },
      {
        id: randomUUID(),
        flow: 'pr-complete',
        branch: 'feat/ordinary',
        parentRunId: null,
        expected: 'trunk',
      },
      {
        id: randomUUID(),
        flow: 'pr-complete',
        branch: 'feat/merged-owned',
        parentRunId: mergedOwnerId,
        expected: 'feat/merged-parent',
      },
    ];
    for (const entry of cases)
      json(path.join(root, '.runs', entry.id + '.json'), {
        ...baseRun(entry.id, entry.flow),
        familyId: entry.parentRunId ?? entry.id,
        branch: entry.branch,
        ticketOrPr: `fixture/missing#${entry.branch === 'feat/retargeted' ? 43 : entry.branch === 'feat/ordinary' ? 44 : 42}`,
        parentRunId: entry.parentRunId,
      });
    const projectWithoutToken = project + '-project-template';
    json(path.join(root, 'projects', projectWithoutToken, 'project.json'), {
      ...projectConfig,
      name: projectWithoutToken,
    });
    const siblingDispatchPrompt = path.join(
      root,
      'projects',
      projectWithoutToken,
      'templates/prompts/worker-dispatch.md',
    );
    mkdirSync(path.dirname(siblingDispatchPrompt), { recursive: true });
    writeFileSync(siblingDispatchPrompt, 'Read {{TASK_FILE}} and follow its checklist.\n');
    const projectCiTemplate = path.join(
      root,
      'projects',
      projectWithoutToken,
      'templates/worker/ci-fix.md',
    );
    mkdirSync(path.dirname(projectCiTemplate), { recursive: true });
    writeFileSync(projectCiTemplate, '# Project CI fix\n\n- [ ] Repair the check\n');
    const nativeNoChange = process.env.FARMSLOT_STACK_BASE_PROOF_ONLY === 'inline-no-change';
    const nativeInline =
      nativeNoChange || process.env.FARMSLOT_STACK_BASE_PROOF_ONLY === 'inline-terminal';
    if (nativeInline)
      writeFileSync(
        projectCiTemplate,
        '# Native inline maintenance proof\n\n- [ ] Execute the exact generated execute command below. Write {{TASK_DIR}}/artifacts/inline-executed.txt, then poll for {{TASK_DIR}}/artifacts/inline-allow-push.txt with a 90-second timeout before proceeding.\n- [ ] Run the exact generated push command.\n- [ ] Use the supplied marker command to start and mark every row of CI-FIX.md, then complete that checklist with disposition fixed and a short summary. Do not run an extra rebase or raw push.\n',
      );
    if (nativeNoChange)
      writeFileSync(
        projectCiTemplate,
        '# Native no-change maintenance proof\n\n- [ ] Run the supplied execute command. Confirm current HEAD is unchanged and write {{TASK_DIR}}/artifacts/inline-executed.txt.\n- [ ] Write the required comments report and no-change evidence using the supplied terminal-contract instructions. The branch is already current; make no code edits and do not push.\n- [ ] Use the supplied marker to complete this checklist with disposition already_fixed and a truthful summary of the unchanged branch.\n',
      );
    const inlineCases = (
      nativeInline ? [projectWithoutToken] : [project, projectWithoutToken]
    ).flatMap((selectedProject) =>
      (nativeInline ? [false] : [false, true]).map((retargeted) => {
        const parentRunId = randomUUID();
        json(path.join(root, '.runs', parentRunId + '.json'), {
          ...baseRun(parentRunId, 'dev'),
          project: selectedProject,
          branch: 'feat/inline',
          prNumber: 45,
          status: 'done',
          completedAt: now,
          stack: { ...stack, ...(retargeted ? { retargetedTo: 'trunk', upstreamMergeSha } : {}) },
          engineState: { generation: 0, publishGate: { maintainedSnapshot: initialCheckpoint } },
        });
        const id = randomUUID();
        const relativeTaskDir = 'fix/inline-' + id;
        const taskFile = path.join(
          root,
          'projects',
          selectedProject,
          'tasks',
          relativeTaskDir,
          'TASK.md',
        );
        const slotTaskDir = path.join(repo, '.task', relativeTaskDir);
        for (const taskDir of [path.dirname(taskFile), slotTaskDir]) {
          mkdirSync(taskDir, { recursive: true });
          writeFileSync(
            path.join(taskDir, 'TASK.md'),
            '# Retained task without a publication-base section\n',
          );
          writeFileSync(path.join(taskDir, 'CHECKLIST.md'), '- [ ] Original work\n');
        }
        const seeded = baseRun(id, 'update-branch');
        json(path.join(root, '.runs', id + '.json'), {
          ...seeded,
          ...(nativeInline
            ? { scripted: undefined, metrics: { ...seeded.metrics, runner: 'codex', model: null } }
            : {}),
          familyId: parentRunId,
          branch: 'feat/inline',
          project: selectedProject,
          parentRunId,
          taskFile,
          prNumber: 41,
          agentContexts: [
            {
              id: 'primary',
              label: 'Primary',
              role: 'primary',
              status: 'working',
              runner: nativeInline ? 'codex' : 'scripted',
              runId: id,
              slotId,
              taskFile: path.join('.task', relativeTaskDir, 'TASK.md'),
              target: { session, window: 'proof', pane: null, target: session + ':proof' },
            },
          ],
          steps: seeded.steps.map((step) => ({
            ...step,
            status: step.name === 'ci-watch' ? 'failed' : 'done',
          })),
        });
        return {
          id,
          project: selectedProject,
          slotTaskDir,
          expected: retargeted ? 'trunk' : 'feat/upstream',
        };
      }),
    );
    // Immutable upstream input at the existing CLI boundary; no CI-writer outputs are supplied.
    const fixtureBin = path.join(scratch, 'bin');
    mkdirSync(fixtureBin);
    writeFileSync(
      path.join(fixtureBin, 'gh'),
      `#!${process.execPath}\nconst args=process.argv.slice(2);let body='';if(args[0]==='pr'&&args[1]==='checks')body='fixture\\tfail\\t\\t\\tFAILURE\\t\\n';else if(args[0]==='pr'&&args[1]==='view')body='OPEN\\tMERGEABLE\\tCLEAN\\t\\tfeat/child\\t\\t\\t\\t\\tFixture PR\\nfixture\\n';else if(args.some(arg=>arg.endsWith('/commits')))body=${JSON.stringify(now)};if(args.includes('--include'))process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n');process.stdout.write(body);\n`,
      { mode: 0o755 },
    );
    json(path.join(root, '.farm-status.json'), {
      checked_at: now,
      slots: [
        {
          slot: slotId,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'ready',
          phase: 'idle',
        },
      ],
    });
    execFileSync('tmux', ['-N', 'new-session', '-d', '-s', session, '-n', 'proof', '-c', scratch]);
    ownedSession = true;
    const port = createServer();
    port.listen(0, '127.0.0.1');
    await once(port, 'listening');
    const address = port.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => port.close(() => resolve()));
    const loader = path.join(scratch, 'checkpoint.mjs');
    const checkpoint = `{ const result = await executeWriteTaskStep(runId, run, {broadcastFn,stepPartialIO}); const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.written',String(getRun(runId).engineState?.generation??0));const until=Date.now()+90000;while(!fs.existsSync(${JSON.stringify(out)}+'/'+runId+'.release')){if(Date.now()>until)throw new Error('Proof checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,50));}return result;}`;
    const renewCheckpoint = `const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.renewed','renewed');const until=Date.now()+90000;while(getRun(runId)?.status!=='cancelled'){if(Date.now()>until)throw new Error('Renewal proof timed out');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Proof stopped after native checkpoint commit');`;
    const reviewCheckpoint = `{ const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.pre-review','held');const until=Date.now()+90000;while(getRun(runId)?.status!=='cancelled'){if(Date.now()>until)throw new Error('Review scheduling proof timed out');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Proof review scheduling cancelled'); }`;
    const inlineCheckpoint = nativeInline
      ? `{ const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.inline-written','written'); }`
      : `{ const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.inline-written','written');const until=Date.now()+90000;while(!signal.aborted){if(Date.now()>until)throw new Error('Inline proof checkpoint timed out');await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Inline proof cancelled after native writer'); }`;
    const inlineObserve = `const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.inline-progress',JSON.stringify({head:currentSha,baseline:beforeSha,pending:pendingBranchMaintenance(getRun(runId))?.id,active:getRun(runId)?.steps.find(step=>step.name==='ci-watch')?.outputs?.fixInProgress}));const alive = await isWorkerSessionAlive(slotId, runner, runId);`;
    const inlineFinish = `  if(result?.success){const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(out)}+'/'+runId+'.inline-complete',JSON.stringify(result));while(!signal.aborted)await new Promise(resolve=>setTimeout(resolve,50));}return result;\n}\n\nexport async function rerunFailedChecks`;
    writeFileSync(
      loader,
      `import{registerHooks}from'node:module';import assert from'node:assert/strict';registerHooks({load(url,context,next){const result=next(url,context);const before=String(result.source);if(url.endsWith('/services/gateway/src/run-engine/post-dispatch-steps.ts')){const after=before.replace('await completeBranchMaintenance(current);', 'await completeBranchMaintenance(current);'+${JSON.stringify(renewCheckpoint)});assert.notEqual(after,before);return{...result,source:after};}if(process.env.FARMSLOT_STACK_BASE_PROOF_BREAK==='renewal'&&url.endsWith('/services/gateway/src/run-engine/branch-maintenance.ts')){const after=before.replace('await commitRunPublication(', 'await ((_id,_build,_assert)=>Promise.resolve(owner))(');assert.notEqual(after,before);return{...result,source:after};}if(process.env.FARMSLOT_STACK_BASE_PROOF_BREAK==='writer'&&url.endsWith('/services/gateway/src/tasks/writer.ts')){const after=before.replace('? await publicationBaseForRun(run, defaultBranch)', '? defaultBranch');assert.notEqual(after,before);return{...result,source:after};}if(url.endsWith('/services/gateway/src/ci-monitor/inline-fix.ts')){let after=before.replace('// Delete old CI-FIX-SIGNAL.json so we can detect fresh completion',${JSON.stringify(inlineCheckpoint)});assert.notEqual(after,before);if(${nativeInline}){after=after.replace('const alive = await isWorkerSessionAlive(slotId, runner, runId);',${JSON.stringify(inlineObserve)}).replace('  return result;\\n}\\n\\nexport async function rerunFailedChecks',${JSON.stringify(inlineFinish)});} if(process.env.FARMSLOT_STACK_BASE_PROOF_BREAK==='inline'){const fixed=after.replace('await publicationBaseForRun(run, defaultBranch)','defaultBranch');assert.notEqual(fixed,after);after=fixed;}return{...result,source:after};}if(!url.endsWith('/services/gateway/src/run-engine/orchestrator.ts'))return result;const after=before.replace('return executeWriteTaskStep(runId, run, { broadcastFn, stepPartialIO });',${JSON.stringify(checkpoint)}).replace('case S.REVIEW:', 'case S.REVIEW:'+${JSON.stringify(reviewCheckpoint)});assert.notEqual(after,before);return{...result,source:after};}});`,
    );
    env = {
      ...env,
      FARMSLOT_ROOT: root,
      FARMSLOT_OPERATOR_CHECKOUT: repo,
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_HOME: path.join(scratch, 'home'),
      FARMSLOT_GATEWAY_PROFILE:
        (testGatewayIdentity(path.join(scratch, 'home'), `ws://127.0.0.1:${address.port}`),
        'proof'),
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
      FARMSLOT_DEMO_POOL: '0',
      NODE_TEST_CONTEXT: '1',
      TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(address.port),
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${address.port}`,
      FARMSLOT_RPC_TIMEOUT_MS: '30000',
      NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import ${loader}`,
      PATH: fixtureBin + path.delimiter + env.PATH,
    };
    const startGateway = async () => {
      gateway = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve'],
        { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      for (const stream of [gateway.stdout, gateway.stderr])
        stream?.on('data', (data) => logs.push(String(data)));
      await wait(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${address.port}/health`)).ok;
        } catch (error) {
          if (error instanceof TypeError) return false;
          throw error;
        }
      }, 'gateway');
    };
    await startGateway();
    const results = [];
    for (const entry of ['inline', 'inline-terminal', 'inline-no-change'].includes(
      process.env.FARMSLOT_STACK_BASE_PROOF_ONLY ?? '',
    )
      ? []
      : failAfterPush
        ? cases.slice(0, 1)
        : cases) {
      if (entry.expected === 'feat/upstream') {
        git('checkout', 'feat/upstream');
        writeFileSync(path.join(repo, 'upstream-new.txt'), entry.id + '\n');
        git('add', 'upstream-new.txt');
        git('commit', '-m', 'test: advance publication target');
        git('push', 'origin', 'feat/upstream');
        git('checkout', 'trunk');
      }
      rpc('run.replayStep', { runId: entry.id, stepName: 'write-task', triggeredBy: 'operator' });
      await wait(() => {
        const run = rpc('run.get', { runId: entry.id }).run;
        if (run.status === 'failed') throw new Error(run.error);
        return existsSync(path.join(out, entry.id + '.written'));
      }, 'write-task');
      let run = rpc('run.get', { runId: entry.id }).run;
      assert.ok(run.taskFile);
      let task = readFileSync(run.taskFile, 'utf8');
      let checklist = readFileSync(path.join(path.dirname(run.taskFile), 'CHECKLIST.md'), 'utf8');
      const publicationBase = task.match(/^PUBLICATION_BASE: (.+)$/m)?.[1];
      assert.equal(publicationBase, entry.expected);
      assert.ok(checklist.includes('origin/' + entry.expected));
      assert.ok(
        run.steps
          .filter((step: { name: string }) => ['prepare', 'dispatch'].includes(step.name))
          .every((step: { startedAt?: string }) => !step.startedAt),
      );
      json(path.join(out, entry.id + '.json'), { run, task, checklist });
      results.push({
        flow: entry.flow,
        expected: entry.expected,
        publicationBase,
        runId: entry.id,
      });
      let operation = run.steps.find((step: { name: string }) => step.name === 'write-task')
        ?.outputs?.branchMaintenanceOperation as BranchMaintenanceOperation | undefined;
      if (entry.parentRunId) {
        assert.ok(operation, 'public writer must retain stack input before handoff');
        assert.equal(operation.ownerRunId, entry.parentRunId);
        assert.equal(operation.baseRef, entry.expected);
      } else assert.equal(operation, undefined);
      let executeCommand = task.match(/^node .*branch-update\.mjs.* execute .+$/m)?.[0];
      let pushCommand = task.match(/^node .*branch-update\.mjs.* push .+$/m)?.[0];
      assert.ok(
        executeCommand && pushCommand,
        'execute the commands actually rendered by the supplying runtime',
      );
      if (entry === cases[0]) {
        const staleInput = operation;
        const oldTaskFile = run.taskFile;
        const oldTask = task;
        assert.ok(staleInput);
        git('checkout', 'feat/upstream');
        writeFileSync(path.join(repo, 'late-parent.txt'), 'parent advanced after handoff\n');
        git('add', 'late-parent.txt');
        git('commit', '-m', 'test: advance parent after captured handoff');
        git('push', 'origin', 'feat/upstream');
        git('checkout', entry.branch);
        assert.throws(
          () =>
            execFileSync('bash', ['-eu', '-c', executeCommand!], {
              cwd: repo,
              encoding: 'utf8',
              stdio: 'pipe',
            }),
          /TARGET_CHANGED/,
        );
        rpc('run.replayStep', { runId: entry.id, stepName: 'write-task', triggeredBy: 'operator' });
        await wait(() => {
          const replayed: Run = rpc('run.get', { runId: entry.id }).run;
          if (replayed.status === 'failed')
            throw new Error(replayed.error ?? 'Stale input recovery refused');
          return (
            readFileSync(path.join(out, entry.id + '.written'), 'utf8') ===
            String(replayed.engineState?.generation ?? 0)
          );
        }, 'new verified input after stale parent refusal');
        run = rpc('run.get', { runId: entry.id }).run;
        task = readFileSync(run.taskFile, 'utf8');
        checklist = readFileSync(path.join(path.dirname(run.taskFile), 'CHECKLIST.md'), 'utf8');
        operation = run.steps.find((step: { name: string }) => step.name === 'write-task')?.outputs
          ?.branchMaintenanceOperation;
        assert.ok(operation);
        assert.notEqual(operation.id, staleInput.id);
        assert.equal(operation.targetSha, git('rev-parse', 'origin/feat/upstream'));
        assert.equal(operation.expectedCheckpoint?.headSha, staleInput.expectedCheckpoint?.headSha);
        assert.equal(
          readFileSync(oldTaskFile, 'utf8'),
          oldTask,
          'refusal retains the old task bytes',
        );
        executeCommand = task.match(/^node .*branch-update\.mjs.* execute .+$/m)?.[0];
        pushCommand = task.match(/^node .*branch-update\.mjs.* push .+$/m)?.[0];
        assert.ok(executeCommand && pushCommand);
        json(path.join(out, entry.id + '.stale-retry.json'), {
          staleInput,
          operation,
          oldTaskFile,
          oldTaskUnchanged: true,
        });
      }
      git('checkout', entry.branch);
      execFileSync('bash', ['-eu', '-c', executeCommand], { cwd: repo, encoding: 'utf8' });
      execFileSync('bash', ['-eu', '-c', pushCommand], { cwd: repo, encoding: 'utf8' });
      if (entry.branch === 'feat/merged-owned') {
        assert.equal(readFileSync(path.join(repo, 'child.txt'), 'utf8'), 'child\n');
        assert.equal(existsSync(path.join(repo, 'parent.txt')), false);
        assert.equal(existsSync(path.join(repo, 'unrelated-default.txt')), false);
        assert.deepEqual(
          JSON.parse(
            readFileSync(path.join(path.dirname(mergedTask), mergedPackage.artifactPath), 'utf8'),
          ),
          mergedPackage,
        );
      }
      const pushedHead = git('rev-parse', 'HEAD');
      assert.equal(readFileSync(run.taskFile, 'utf8'), task);
      assert.equal(
        readFileSync(path.join(path.dirname(run.taskFile), 'CHECKLIST.md'), 'utf8'),
        checklist,
      );
      if (entry === cases[0]) {
        // Preserve durable operation inputs and the real push; restart before renewal.
        await stopGateway();
        await startGateway();
        rpc('run.replayStep', { runId: entry.id, stepName: 'write-task', triggeredBy: 'operator' });
        await wait(() => {
          const restarted: Run = rpc('run.get', { runId: entry.id }).run;
          if (restarted.status === 'failed') throw new Error(restarted.error ?? 'Restart refused');
          return (
            readFileSync(path.join(out, entry.id + '.written'), 'utf8') ===
            String(restarted.engineState?.generation ?? 0)
          );
        }, 'write-task recovery');
        const restarted: Run = rpc('run.get', { runId: entry.id }).run;
        const retained = restarted.steps.find((step) => step.name === 'write-task')?.outputs
          ?.branchMaintenanceOperation;
        assert.deepEqual(
          retained,
          operation,
          'restart and explicit write-task replay retain the exact input',
        );
        assert.equal(readFileSync(run.taskFile, 'utf8'), task);
      }
      if (operation) {
        rpc('run.replayStep', {
          runId: entry.id,
          stepName: 'complete',
          triggeredBy: 'operator',
          skipPrepare: true,
        });
        writeFileSync(path.join(out, entry.id + '.release'), 'superseded');
        await wait(() => {
          const current: Run = rpc('run.get', { runId: entry.id }).run;
          if (current.status === 'failed' && !failAfterPush)
            throw new Error(current.error ?? 'Worker failed');
          return (
            (failAfterPush && current.status === 'failed') ||
            existsSync(path.join(out, entry.id + '.renewed')) ||
            existsSync(path.join(out, entry.id + '.pre-review'))
          );
        }, 'real scripted worker completion');
        if (failAfterPush && !existsSync(path.join(out, entry.id + '.renewed'))) {
          const failed: Run = rpc('run.get', { runId: entry.id }).run;
          assert.equal(
            failed.metrics.disposition,
            'failed',
            'actual command failure is recorded after its successful push',
          );
          assert.equal(
            failed.steps.find((step) => step.name === 'write-task')?.outputs
              ?.branchMaintenanceOperation !== undefined,
            true,
          );
          rpc('run.replayStep', {
            runId: entry.id,
            stepName: 'complete',
            triggeredBy: 'operator',
            skipPrepare: true,
          });
          await wait(
            () => existsSync(path.join(out, entry.id + '.renewed')),
            'terminal failed work reconciles its real pushed result',
          );
        }
        if (existsSync(path.join(out, entry.id + '.pre-review'))) {
          rpc('run.replayStep', { runId: entry.id, stepName: 'complete', triggeredBy: 'operator' });
          await wait(
            () => existsSync(path.join(out, entry.id + '.renewed')),
            'native renewal after review scheduling',
          );
        }
        const current: Run = rpc('run.get', { runId: entry.id }).run;
        const primaryTask = current.agentContexts?.find(
          (context) => context.role === 'primary',
        )?.taskFile;
        assert.ok(primaryTask, 'native dispatch binds the primary task');
        const workerDir = path.dirname(path.resolve(repo, primaryTask));
        const commandResult = JSON.parse(
          readFileSync(path.join(workerDir, 'artifacts/scripted-command-result.json'), 'utf8'),
        );
        assert.equal(commandResult.exitCode, failAfterPush ? 1 : 0);
        assert.equal(commandResult.timedOut, false);
        const owner: Run = rpc('run.get', { runId: entry.parentRunId }).run;
        const successor = owner.engineState?.publishGate?.maintainedSnapshot;
        assert.equal(
          successor?.headSha,
          pushedHead,
          'production completion renews publishing authority',
        );
        assert.equal(successor?.baseSha, operation.targetSha);
        assert.equal(successor?.replayBoundarySha, operation.targetSha);
        assert.equal(owner.stack?.resolvedSha, parentSha);
        assert.equal(owner.engineState?.publishGate?.publicationStatus, undefined);
        assert.equal(readFileSync(run.taskFile, 'utf8'), task);
        json(path.join(out, entry.id + '.renewal.json'), {
          operation,
          successor,
          run: rpc('run.get', { runId: entry.id }).run,
          restartAfterPush: entry === cases[0],
        });
      }
      rpc('run.cancel', { runId: entry.id });
      writeFileSync(path.join(out, entry.id + '.release'), 'cancelled');
      await wait(() => rpc('run.get', { runId: entry.id }).run.status === 'cancelled', 'cancel');
      if (!failAfterPush) {
        await wait(() => {
          const rows = JSON.parse(readFileSync(path.join(root, '.farm-status.json'), 'utf8')).slots;
          const row = rows.find((candidate: { slot: string }) => candidate.slot === slotId);
          return row?.lifecycle === 'ready' && row?.phase !== 'releasing' && !row?.current_run_id;
        }, 'owned slot release');
      }
      assert.equal(git('rev-list', '--count', `origin/${entry.expected}..HEAD`), '1');
    }
    const inlineResults = [];
    if (!failAfterPush && process.env.FARMSLOT_STACK_BASE_PROOF_ONLY !== 'maintenance') {
      const workerTaskDir = path.join(scratch, 'scripted-worker');
      if (nativeInline) {
        const { installHooks } = await import('../lib/install.mjs');
        installHooks('codex', repo, '.task', slotId);
      }
      const command = nativeInline
        ? buildCodexExecLaunch({
            binary: 'codex',
            repo,
            runtimeDir: '.task',
            safetyTier: 'dangerous',
          })
        : [
            'env',
            'FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1',
            `FARMSLOT_ROOT=${source}`,
            `TSX_TSCONFIG_PATH=${path.join(source, 'services/gateway/tsconfig.json')}`,
            process.execPath,
            '--import',
            'tsx',
            path.join(source, 'packages/cli/src/scripted-runner-entry.ts'),
            'scripted-runner',
            '--task-dir',
            workerTaskDir,
            '--mode',
            'scenario',
            '--scenario',
            'timeout',
            '--step-delay-ms',
            '600000',
          ]
            .map(shSingleQuote)
            .join(' ');
      execFileSync('tmux', [
        '-N',
        'respawn-pane',
        '-k',
        '-t',
        `=${session}:proof`,
        `cd ${shSingleQuote(nativeInline ? repo : source)} && exec ${command}`,
      ]);
      if (!nativeInline)
        await wait(
          () => existsSync(path.join(workerTaskDir, 'artifacts/scripted-runner-provenance.json')),
          'scripted worker',
        );
      else {
        if (!nativeNoChange) {
          git('checkout', 'feat/upstream');
          writeFileSync(path.join(repo, 'inline-parent.txt'), 'inline target advanced\n');
          git('add', 'inline-parent.txt');
          git('commit', '-m', 'test: advance inline base');
          git('push', 'origin', 'feat/upstream');
        }
        git('checkout', 'feat/inline');
      }
      for (const entry of inlineCases) {
        rpc('run.replayStep', { runId: entry.id, stepName: 'ci-watch', triggeredBy: 'operator' });
        await wait(
          () => existsSync(path.join(out, entry.id + '.inline-written')),
          'native inline writer',
        );
        const checklist = readFileSync(path.join(entry.slotTaskDir, 'CI-FIX.md'), 'utf8');
        assert.ok(checklist.includes('Branch updates target `origin/' + entry.expected + '`'));
        assert.ok(checklist.includes('pre-rebase-remote-sha.txt'));
        assert.equal(
          readFileSync(path.join(entry.slotTaskDir, 'TASK.md'), 'utf8'),
          '# Retained task without a publication-base section\n',
        );
        const run = rpc('run.get', { runId: entry.id }).run;
        json(path.join(out, entry.id + '.json'), { run, checklist });
        if (nativeInline) {
          const ownerId = run.parentRunId;
          const oldCheckpoint = rpc('run.get', { runId: ownerId }).run.engineState.publishGate
            .maintainedSnapshot;
          await wait(
            () => existsSync(path.join(entry.slotTaskDir, 'artifacts/inline-executed.txt')),
            'native execute before push',
            210_000,
          );
          if (!nativeNoChange) {
            await wait(() => {
              const file = path.join(out, entry.id + '.inline-progress');
              if (!existsSync(file)) return false;
              const progress = JSON.parse(readFileSync(file, 'utf8'));
              return progress.head !== progress.baseline && progress.pending && progress.active;
            }, 'rebase remains progress before terminal push');
            assert.deepEqual(
              rpc('run.get', { runId: ownerId }).run.engineState.publishGate.maintainedSnapshot,
              oldCheckpoint,
            );
            writeFileSync(
              path.join(entry.slotTaskDir, 'artifacts/inline-allow-push.txt'),
              'push allowed\n',
            );
          }
          await wait(
            () => existsSync(path.join(out, entry.id + '.inline-complete')),
            'native terminal signal and guarded push',
          );
          const latest: Run = rpc('run.get', { runId: entry.id }).run;
          const owner: Run = rpc('run.get', { runId: ownerId }).run;
          if (nativeNoChange) {
            assert.deepEqual(owner.engineState?.publishGate?.maintainedSnapshot, oldCheckpoint);
            assert.equal(
              latest.steps.find((step) => step.name === 'write-task')?.outputs
                ?.branchMaintenanceOperation,
              undefined,
            );
            assert.equal(git('rev-parse', 'HEAD'), oldCheckpoint.headSha);
          } else {
            assert.equal(
              owner.engineState?.publishGate?.maintainedSnapshot?.headSha,
              git('rev-parse', 'HEAD'),
            );
            assert.equal(
              latest.steps.find((step) => step.name === 'write-task')?.outputs
                ?.branchMaintenanceCompleted,
              true,
            );
          }
          assert.equal(
            latest.steps.find((step) => step.name === 'ci-watch')?.outputs?.fixInProgress,
            false,
          );
          assert.equal(
            latest.agentContexts?.find((context) => context.role === 'ci-fix')?.status,
            'complete',
          );
          json(path.join(out, entry.id + '.native-terminal.json'), {
            oldCheckpoint,
            latest,
            successor: owner.engineState?.publishGate?.maintainedSnapshot,
          });
        }
        inlineResults.push({ project: entry.project, expected: entry.expected, runId: entry.id });
        rpc('run.cancel', { runId: entry.id });
        await wait(
          () => rpc('run.get', { runId: entry.id }).run.status === 'cancelled',
          'inline cancel',
        );
      }
    }
    json(path.join(out, 'receipt.json'), {
      pass: true,
      results,
      inlineResults,
      rebaseBase: results[0]?.publicationBase ?? null,
      childCommits: results.length > 0 ? 1 : null,
      sharedCommandsExecuted: results.length > 0,
      checkpointRenewal: results.length > 0,
      restartAfterPush: results.length > 0,
      originalRunsUntouched: true,
      failedAfterGuardedPush: failAfterPush,
      limits: [
        ...(failAfterPush
          ? [
              'The deliberately failed worker remains held for inspection; this control proves terminal checkpoint reconciliation, not slot cleanup. Its isolated gateway and owned session are torn down.',
            ]
          : []),
        'Seeded immutable fixture input before gateway start; production replay RPC and writer derive task values.',
        'The scheduling checkpoint only holds after the native writer; no computed task or run result is substituted.',
        'Generated commands execute through the real scripted command runner. Public replay reaches the native completion writer after actual dispatch and monitor; scheduling stops immediately after checkpoint renewal. No review, acceptance or publication approval is supplied.',
        'Native CI writer consumes fixture upstream reads and a real scripted-worker process; held before nudge delivery. No original run or UI changes; existing server and one owned detached session only.',
      ],
    });
    console.log(JSON.stringify({ pass: true, out }));
  } finally {
    await stopGateway();
    if (ownedSession) execFileSync('tmux', ['-N', 'kill-session', '-t', `=${session}`]);
    json(path.join(out, 'logs.json'), logs);
    // Retain isolated fixture input and packages for the receipt; no real checkouts changed.
  }
}

/** Public proof on an ordinary retained run; setup never supplies a stack record. */
async function proveRetainedAttachment(afterRestart: boolean): Promise<void> {
  const file = process.env.FARMSLOT_STACK_ATTACHMENT_PROOF_CONFIG;
  assert.ok(file, 'Set FARMSLOT_STACK_ATTACHMENT_PROOF_CONFIG to the retained-run proof inputs');
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(isRecord(input));
  const text = (name: string): string => {
    const value = input[name];
    assert.equal(typeof value, 'string', `Missing proof input ${name}`);
    assert.ok(typeof value === 'string' && value.length > 0);
    return value;
  };
  const params = {
    graphId: text('graphId'),
    nodeId: text('nodeId'),
    runId: text('runId'),
    expectedHeadSha: text('expectedHeadSha'),
  };
  assert.match(params.expectedHeadSha, /^[a-f0-9]{40}$/);
  const upstreamBranch = text('upstreamBranch');
  const upstreamSha = text('upstreamSha');
  const out = path.resolve(text('outputDir'));
  mkdirSync(out, { recursive: true });
  const target = resolveGatewayTarget({
    gateway: process.env.FARMSLOT_GATEWAY_PROFILE,
    url: process.env.FARMSLOT_GATEWAY,
  });
  const client = new GatewayClient({
    url: target.url,
    credential: target.credential,
    timeout: 60_000,
  });
  const before = (await client.call<RunGetResult>('run.get', { runId: params.runId })).run;
  assert.ok(before.taskFile);
  const taskFile = before.taskFile;
  const taskDir = path.dirname(taskFile);
  const frozen = await readReadyGatePreparedPackage(before);
  assert.ok(frozen, 'The real retained run needs its captured publication inventory');
  const evidence = await readGateRecordedEvidenceSources(before, frozen);
  assert.ok(evidence.length > 0, 'Require a real inventory-qualified execution package');
  const inventoried = (frozen.evidenceManifest ?? []).map((ref) => {
    const retained = path.resolve(taskDir, ref.path);
    assert.ok(retained.startsWith(taskDir + path.sep));
    return retained;
  });
  const files = (directory: string): string[] =>
    !existsSync(directory)
      ? []
      : readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? files(path.join(directory, entry.name))
            : entry.isFile()
              ? [path.join(directory, entry.name)]
              : [],
        );
  const hashes = (): Record<string, string> =>
    Object.fromEntries(
      [
        taskFile,
        ...inventoried,
        path.join(taskDir, 'CHECKLIST.md'),
        ...files(path.join(taskDir, 'inputs')),
        ...files(path.join(taskDir, 'artifacts/recipe-runs')),
      ]
        .filter(existsSync)
        .sort()
        .map((name) => [
          path.relative(taskDir, name),
          createHash('sha256').update(readFileSync(name)).digest('hex'),
        ]),
    );
  const previousFiles = hashes();
  const beforeIds = (await client.call<RunListResult>('run.list', { limit: 1000 })).runs
    .map((run) => run.id)
    .sort();
  const baseline = path.join(out, 'before-files.json');
  if (afterRestart) {
    assert.equal(before.workGraphId, params.graphId);
    assert.equal(before.workNodeId, params.nodeId);
    assert.deepEqual(previousFiles, JSON.parse(readFileSync(baseline, 'utf8')));
  } else {
    assert.equal(before.workGraphId, undefined);
    assert.equal(before.stack, undefined);
    assert.ok(!before.prNumber);
    writeFileSync(baseline, JSON.stringify(previousFiles, null, 2) + '\n');
    await assert.rejects(
      client.call('workGraph.attachRun', { ...params, expectedHeadSha: '0'.repeat(40) }),
      (error: unknown) => isRecord(error) && error.code === 'WORK_GRAPH_ATTACH_HEAD_CHANGED',
    );
    const refused = (await client.call<RunGetResult>('run.get', { runId: params.runId })).run;
    assert.equal(refused.stack, undefined);
    const cli = spawnSync(
      process.execPath,
      [
        path.join(source, 'packages/cli/bin/farmslot.mjs'),
        '--json',
        '--url',
        target.url,
        'graph',
        'attach-run',
        params.graphId,
        params.nodeId,
        params.runId,
        '--expected-head',
        params.expectedHeadSha,
      ],
      {
        cwd: source,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(source, 'packages/cli/tsconfig.json') },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    writeFileSync(path.join(out, 'cli.stdout.json'), cli.stdout);
    writeFileSync(path.join(out, 'cli.stderr.log'), cli.stderr);
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.deepEqual(hashes(), previousFiles);
  }
  const result = await client.call<WorkGraphAttachRunResult>('workGraph.attachRun', params);
  assert.equal(result.run.workGraphId, params.graphId);
  assert.equal(result.run.workNodeId, params.nodeId);
  assert.equal(result.run.stack?.baseBranch, upstreamBranch);
  assert.equal(result.run.stack?.resolvedSha, upstreamSha);
  assert.equal(result.run.id, before.id);
  assert.equal(result.run.familyId, before.familyId);
  assert.equal(result.run.taskFile, before.taskFile);
  assert.deepEqual(result.run.steps, before.steps);
  assert.deepEqual(hashes(), previousFiles);
  assert.deepEqual(
    (await client.call<RunListResult>('run.list', { limit: 1000 })).runs
      .map((run) => run.id)
      .sort(),
    beforeIds,
  );
  writeFileSync(
    path.join(out, afterRestart ? 'after-restart.json' : 'attachment.json'),
    JSON.stringify(
      {
        params,
        run: result.run,
        graph: result.graph,
        publicationRefreshRequired: result.publicationRefreshRequired,
        taskAndEvidencePreserved: true,
        noRunCreated: true,
        afterRestart,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      pass: true,
      runId: params.runId,
      afterRestart,
      preservedFiles: Object.keys(previousFiles).length,
    }),
  );
}
