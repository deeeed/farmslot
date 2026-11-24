// Live proof (04837a3a): a comparison replay leaves its review fix uncommitted, and its warm
// re-review resumes the same reviewer on the working tree instead of refusing "fix not committed".
// Other artifact-only runs still commit their fix first. Real gateway review path, run store and
// local native host; the Codex app-server is scripted, so no model runs.
// Run from services/gateway: TSX_TSCONFIG_PATH=tsconfig.json node --import tsx
//   --experimental-test-module-mocks --test --test-force-exit <this file>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../runtime/mock-pty.test-support.js';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

import { installScriptedCodex } from './native-review-proof.live-support.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test(
  'a comparison replay re-reviews its uncommitted fix warm; other artifact-only runs commit first',
  { timeout: 180_000 },
  async (t) => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-only-rereview-proof-'));
    const repo = path.join(root, 'repo');
    const taskDir = 'tasks/review';
    const slotId = 'artifact-only-proof-slot';
    const project = 'artifact-only-proof';
    const write = async (rel: string, text: string) => {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    };
    await write('CLAUDE.md', 'Isolated native review proof fixture.\n');
    await write('services/gateway/package.json', '{}\n');
    await symlink(path.join(source, 'scripts'), path.join(root, 'scripts'));
    await symlink(path.join(source, 'packages'), path.join(root, 'packages'));
    await write(
      `projects/${project}/project.json`,
      JSON.stringify({
        name: project,
        task_dir: 'tasks',
        runtime_dir: '.agent',
        default_branch: 'main',
      }),
    );
    await write(
      `projects/${project}/templates/worker/review.static-code.md`,
      '# Review the text fixture\n\n- [ ] 1. Read message.txt and the diff.\n- [ ] 2. Record the review result and feedback, then mark this checklist complete.\n',
    );
    // The native proof fixture removes `root`; the scripted binary lives outside it.
    const codexDir = await mkdtemp(path.join(os.tmpdir(), 'scripted-codex-'));
    t.after(() => rm(codexDir, { recursive: true, force: true }));
    const codex = await installScriptedCodex(codexDir);
    await write(
      'pool/local.json',
      JSON.stringify({
        schema_version: 2,
        machine: os.hostname(),
        project,
        platform: 'macos',
        os: process.platform,
        host: 'localhost',
        ssh_user: os.userInfo().username,
        codex_path: codex.binary,
        slots: [{ id: slotId, enabled: true, repo, session: 'unused-native-proof', resources: {} }],
      }),
    );
    await mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const commit = (message: string) => {
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        message,
      );
    };
    git('init', '--quiet', '-b', 'main');
    await write('repo/.gitignore', 'tasks/\n.agent/\n');
    await write('repo/message.txt', 'base\n');
    commit('test: initialize');
    git('checkout', '--quiet', '-b', 'proof-change');
    await write('repo/message.txt', 'hello\n');
    commit('test: change');
    git('remote', 'add', 'origin', repo);
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
    await write(`repo/${taskDir}/TASK.md`, '# Text review proof\n\nLocal fixture only.\n');
    await write(`repo/${taskDir}/CHECKLIST.md`, '# Worker\n\n- [x] 1. Update message.txt.\n');

    process.env.FARMSLOT_ROOT = root;
    process.env.NODE_TEST_CONTEXT = '1';
    // Not named .farm-status.json: next to the fixture's farm markers that names a shared store.
    process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'proof-status.json');
    process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
    process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
    process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
    process.env.FARMSLOT_NATIVE_STATE_DIR = path.join(root, 'native');
    process.env.FARMSLOT_DISABLE_RUN_ENGINE_START = '1';
    const { person } = await createNativeProofFixture(t, root);
    const { shellQuote } = await import('../core/tmux.js');
    await write(
      `repo/${taskDir}/mark`,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'))} ${shellQuote(path.join(repo, taskDir))} "$@"\n`,
    );
    await chmod(path.join(repo, taskDir, 'mark'), 0o700);
    const { loadSlotVars } = await import('../core/config.js');
    const { rewriteStatusFile } = await import('../core/state.js');
    const { createRun, updateRun } = await import('../runs/store.js');
    const { runWithSessionOriginator } = await import('../security/work-originator.js');
    const { runNativeReviewAgent } = await import('./native-review-agent.js');
    const vars = await loadSlotVars(slotId);
    const model = 'gpt-6.1-sol';
    // A source-mode host can still be importing when the client's 10 s startup wait ends, so
    // start the private host and wait for it before the first launch.
    const { nativeSessionManager } = await import('../runners/native/manager.js');
    // A slow first start only ends the client's wait early; the ready file decides, and a host
    // that never gets ready reports this error with its log.
    const warming = await nativeSessionManager.warm().then(
      () => null,
      (error: unknown) => error,
    );
    for (
      const deadline = Date.now() + 120_000;
      !existsSync(path.join(root, 'native/ready.json'));
    ) {
      if (Date.now() > deadline)
        assert.fail(
          `the private native host did not become ready (${String(warming)}):\n${await readFile(path.join(root, 'native/host.log'), 'utf8').catch(String)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    /** An artifact-only dev run on the slot; `lane` makes it a comparison replay. */
    const artifactOnlyRun = async (ticket: string, lane?: 'comparison') => {
      const run = runWithSessionOriginator(person, () =>
        createRun({
          flowType: 'dev',
          project,
          ticketOrPr: ticket,
          slotId,
          transport: 'native',
          safetyTier: 'dangerous',
          runner: 'codex',
          model,
        }),
      );
      updateRun(run.id, {
        status: 'reviewing',
        branch: 'proof-change',
        taskFile: path.join(repo, taskDir, 'TASK.md'),
        completionPolicy: 'artifact-only',
        ...(lane ? { lane } : {}),
      });
      await rewriteStatusFile(() => ({
        slots: [
          {
            slot: slotId,
            machine: os.hostname(),
            project,
            current_run_id: run.id,
            slot_epoch: 1,
            task_file: path.join(repo, taskDir, 'TASK.md'),
            lifecycle: 'busy',
            phase: 'working',
            agent: 'idle',
          },
        ],
      }));
      type ReviewOptions = Partial<Parameters<typeof runNativeReviewAgent>[0]>;
      return async (label: string, options: ReviewOptions = {}) => {
        const started = Date.now();
        try {
          const result = await runWithSessionOriginator(person, () =>
            runNativeReviewAgent({
              vars,
              runner: 'codex',
              model,
              taskDir,
              runId: run.id,
              reviewTimeoutMs: 120_000,
              loopNumber: 1,
              validationDepth: 'static-code',
              mode: 'cold',
              reviewId: `artifact-only-${ticket.toLowerCase()}`,
              effort: 'high',
              ...options,
            }),
          );
          console.log(
            `[proof] ${ticket} ${label}: ${result.mode} verdict ${result.verdict} after ${Date.now() - started}ms`,
          );
          return result;
        } catch (error) {
          console.log(
            `[proof] ${ticket} ${label}: failed after ${Date.now() - started}ms: ${String(error)}`,
          );
          throw error;
        }
      };
    };

    // 1. The comparison replay's cold review asks for a fix.
    const replay = await artifactOnlyRun('ARTIFACT-ONLY-COMPARISON', 'comparison');
    await codex.scenario({ toolMs: 200, verdict: 'issues' });
    const first = await replay('cold review');
    assert.equal(first.verdict, 'issues');
    const head = git('rev-parse', 'HEAD');
    assert.equal(first.reviewSnapshot?.headSha, head);

    // 2. The replay's fix stays in the working tree: HEAD is unchanged and the tree is dirty.
    await write('repo/message.txt', 'hello, fixed\n');
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.match(git('status', '--porcelain'), /message\.txt/);

    // 3. The warm re-review resumes the same reviewer, on the working tree.
    await codex.scenario({ toolMs: 200, verdict: 'pass' });
    const second = await replay('warm re-review', {
      mode: 'warm',
      loopNumber: 2,
      rereview: { lastReviewedHeadSha: head, priorIssues: first.issues },
    });
    assert.equal(second.verdict, 'pass');
    assert.equal(second.mode, 'warm');
    assert.equal(second.session?.continuity, 'resumed');
    assert.equal(second.session?.sessionId, first.session?.sessionId);
    assert.equal(second.reviewerSessionId, first.reviewerSessionId);

    // 4. Its task says the work is uncommitted and how to read it.
    const prompts = await codex.prompts();
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0]!, /## The work is uncommitted/);
    assert.match(prompts[1]!, /## The work is uncommitted/);
    // It names the working-tree diff against HEAD, not a commit range.
    const workingTree = prompts[1]!.split('## The work is uncommitted')[1]!.split('\n# ')[0]!;
    assert.ok(workingTree.includes(` ${head}\``) && !workingTree.includes(`${head}..`));

    // An artifact-only run outside the comparison lane must still commit its fix.
    git('checkout', '--', 'message.txt');
    const other = await artifactOnlyRun('ARTIFACT-ONLY-PLAIN');
    await codex.scenario({ toolMs: 200, verdict: 'issues' });
    const plain = await other('cold review');
    assert.equal(plain.verdict, 'issues');
    await write('repo/message.txt', 'hello, fixed but not committed\n');
    await assert.rejects(
      other('warm re-review', {
        mode: 'warm',
        loopNumber: 2,
        rereview: { lastReviewedHeadSha: head, priorIssues: plain.issues },
      }),
      /Re-review refused: fix not committed/,
    );
    assert.equal((await codex.prompts()).length, 3, 'the refused re-review sent no turn');
  },
);
