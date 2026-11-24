// Live proof (961d55d3): a native reviewer waiting on one long tool call is not killed by the
// inactivity watchdog, and a tool call that never ends is still stopped. Real gateway review
// path, run store and local native host; the Codex app-server is scripted, so no model runs.
// Run from services/gateway: TSX_TSCONFIG_PATH=tsconfig.json node --import tsx
//   --experimental-test-module-mocks --test --test-force-exit <this file>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../runtime/mock-pty.test-support.js';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

import { installScriptedCodex } from './native-review-proof.live-support.js';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// 6 s of silence; an open tool call gets three times that.
const INACTIVITY_MIN = 0.1;
const LIMIT_MS = INACTIVITY_MIN * 60_000;

test(
  'a native reviewer outlives its inactivity limit on one long tool call; a hung one is stopped',
  { timeout: 180_000 },
  async (t) => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-watchdog-proof-'));
    const repo = path.join(root, 'repo');
    const taskDir = 'tasks/review';
    const slotId = 'native-watchdog-proof-slot';
    const project = 'native-watchdog-proof';
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
        review: { review_inactivity_timeout_min: INACTIVITY_MIN },
      }),
    );
    await write(
      `projects/${project}/templates/worker/review.static-code.md`,
      '# Review the text fixture\n\n- [ ] 1. Read message.txt and the diff.\n- [ ] 2. Record the review result and feedback, then mark this checklist complete.\n',
    );
    const codex = await installScriptedCodex(
      await mkdtemp(path.join(os.tmpdir(), 'scripted-codex-')),
    );
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
    await nativeSessionManager.warm().catch((error: unknown) => {
      // The ready file below decides; a slow first start only ends the client's wait early.
      console.log(`[proof] host still starting: ${String(error)}`);
    });
    for (
      const deadline = Date.now() + 120_000;
      !existsSync(path.join(root, 'native/ready.json'));
    ) {
      if (Date.now() > deadline)
        assert.fail(
          `the private native host did not become ready:\n${await readFile(path.join(root, 'native/host.log'), 'utf8').catch(String)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    /** One cold review of a fresh run on the slot, timed. */
    const review = async (ticket: string) => {
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
      const started = Date.now();
      const outcome = await runWithSessionOriginator(person, () =>
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
          reviewId: `watchdog-${ticket.toLowerCase()}`,
          effort: 'high',
        }),
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const elapsedMs = Date.now() - started;
      console.log(
        `[proof] ${ticket}: ${'result' in outcome ? `verdict ${outcome.result.verdict}` : `failed: ${outcome.error instanceof Error ? outcome.error.stack : String(outcome.error)}`} after ${elapsedMs}ms`,
      );
      return { ...outcome, elapsedMs };
    };

    // The one tool call stays open past the 6 s limit and ends well inside 18 s.
    await codex.scenario({ toolMs: LIMIT_MS + 4_000 });
    const long = await review('WATCHDOG-LONG-TOOL');
    assert.ok(
      'result' in long,
      `the reviewer was stopped: ${String('error' in long && long.error)}`,
    );
    assert.equal(long.result.verdict, 'pass');
    assert.ok(long.elapsedMs > LIMIT_MS, 'the tool call outlived the inactivity limit');

    // A tool call that never ends is stopped at three inactivity limits of silence.
    await codex.scenario({});
    const hung = await review('WATCHDOG-HUNG-TOOL');
    assert.ok('error' in hung, 'a hung tool call must not hold the reviewer forever');
    assert.match(
      String(hung.error),
      /tool call made no progress for \d+ms \(open-tool limit 18000ms/,
    );
    assert.ok(hung.elapsedMs >= 3 * LIMIT_MS && hung.elapsedMs < 3 * LIMIT_MS + 10_000);
    console.log(`[proof] scripted turns:\n${await readFile(codex.turnsLog, 'utf8')}`);
  },
);
