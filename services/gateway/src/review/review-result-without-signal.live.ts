// Live proof (961d55d3): a native reviewer that writes a valid ISSUES result and ends its
// completion re-ask without the terminal mark has that result taken as the verdict; a PASS
// written the same way is not. Real gateway review path, run store and local native host; the
// Codex app-server is scripted, so no model runs.
// Run from services/gateway: yarn test:review-result-without-signal-live
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
  'a valid ISSUES result without its terminal mark is the verdict; a PASS is not',
  { timeout: 300_000 },
  async (t) => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const root = await mkdtemp(path.join(os.tmpdir(), 'result-without-signal-proof-'));
    const repo = path.join(root, 'repo');
    const taskDir = 'tasks/review';
    const slotId = 'result-without-signal-proof-slot';
    const project = 'result-without-signal-proof';
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
    const { createRun, getRun, updateRun } = await import('../runs/store.js');
    const { runReviewRoundBudget } = await import('./review-round-budget.js');
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
          reviewId: `no-signal-${ticket.toLowerCase()}`,
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
      return { ...outcome, elapsedMs, runId: run.id };
    };

    // The first turn writes the ISSUES result and stops before its closing marks; the gateway's
    // one completion re-ask then ends without the mark too.
    await codex.scenario({ toolMs: 50, verdict: 'issues', withholdMark: true });
    const issues = await review('NO-SIGNAL-ISSUES');
    assert.ok(
      'result' in issues,
      `the valid ISSUES result was not taken: ${String('error' in issues && issues.error)}`,
    );
    assert.equal(issues.result.verdict, 'issues');
    assert.equal((await codex.prompts()).length, 2, 'one review turn and one completion re-ask');

    // A PASS without the mark is never accepted.
    await codex.scenario({ toolMs: 50, verdict: 'pass', withholdMark: true });
    const pass = await review('NO-SIGNAL-PASS');
    assert.ok('error' in pass, 'a PASS without its terminal mark must not be accepted');
    assert.match(String(pass.error), /PASS result is not accepted without one/);
    const passRun = getRun(pass.runId)!;
    assert.equal(passRun.agentContexts?.find((entry) => entry.role === 'review')?.status, 'failed');
    const passBudget = await runReviewRoundBudget(passRun);
    assert.deepEqual([passBudget.used, passBudget.noVerdict], [0, 1], 'settled no-verdict');

    // A reviewer that never ran `mark start` has no signal: its re-ask may bootstrap one.
    const before = (await codex.prompts()).length;
    await codex.scenario({ toolMs: 50, verdict: 'issues', skipMarks: true });
    const missing = await review('NO-SIGNAL-MISSING');
    assert.ok(
      'result' in missing,
      `the valid ISSUES result was not taken: ${String('error' in missing && missing.error)}`,
    );
    assert.equal(missing.result.verdict, 'issues');
    const missingPrompts = (await codex.prompts()).slice(before);
    assert.equal(missingPrompts.length, 2, 'one review turn and one completion re-ask');
    assert.match(missingPrompts[1]!, /If you never ran .* start, run it once now/);
    console.log(`[proof] scripted turns:\n${await readFile(codex.turnsLog, 'utf8')}`);
  },
);
