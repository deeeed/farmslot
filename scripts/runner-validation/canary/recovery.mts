// Recovery cases use disposable slots; teardown owns a separate restartable stack.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Run } from '../../../packages/protocol/src/index.js';
import type { Reaper } from '../lib/isolated-stack.mjs';
import { writeJson } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';
import { recoveryGithub } from './recovery-github.mjs';
import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';
import { canaryPack, canaryRunParams, SEED } from './fixtures.mjs';
import type { CheckResult } from './outcome.mjs';
import { stepTimings } from './outcome.mjs';
import type { Log } from './run-driver.mjs';

export const RECOVERY_CASES = [
  'deferred-fix-active',
  'review-cap',
  'silent-reviewer',
  'out-of-band-commit',
  'node-timeout',
  'fixer-scope',
  'interrupted-teardown',
] as const;
const exec = promisify(execFile);

export async function runRecoveryMatrix(options: {
  root: string;
  evidence: string;
  reaper: Reaper;
  cliSnapshots: string;
  cliSnapshot?: string;
  onCleanup(stop: () => Promise<string[]>): void;
  onCheck(check: CheckResult): void;
  log: Log;
}) {
  requireRecoveryFaultSupport();
  const started = Date.now();
  const controller = new AbortController();
  const { signal } = controller;
  let jobs: Promise<void>[] = [];
  const stops: Array<() => Promise<string[]>> = [];
  options.onCleanup(async () => {
    controller.abort(new Error('Recovery matrix stopped'));
    await Promise.allSettled(jobs);
    return (await Promise.all(stops.map((stop) => stop()))).flat();
  });
  const startStack = async (
    names: readonly (typeof RECOVERY_CASES)[number][],
    evidence: string,
  ) => {
    await mkdir(evidence, { recursive: true });
    const stack = await startRemoteNodeStack({
      ...options,
      evidence,
      onCleanup: (stop) => {
        stops.push(stop);
      },
      machine: 'recovery-node',
      ownerTag: `recovery-${process.pid}`,
      slots: names.map((name) => `recovery-${name}-1`),
      projects: () =>
        names.map((name) => {
          const pack = canaryPack(true);
          return {
            ...pack,
            name: `recovery-${name}`,
            projectJson: {
              ...pack.projectJson,
              review: {
                enabled: [
                  'deferred-fix-active',
                  'review-cap',
                  'silent-reviewer',
                  'out-of-band-commit',
                ].includes(name),
                runner: 'codex',
                model: 'gpt-6-luna',
                effort: 'low',
                mode: 'cold',
                max_retries: name === 'review-cap' ? 0 : 5,
                review_timeout_min: 0.5,
                review_inactivity_timeout_min: 0.5,
              },
              ci: { enabled: true, repo: 'fixture/recovery' },
              ci_watch: { poll_interval_s: 0.02, timeout_min: 0.1 },
            },
            files: {
              ...pack.files,
              'templates/shared/pr-complete/shared.md':
                '---\nplatforms: [cli]\n---\n\n# Complete PR\n\n- [ ] Complete the fixture PR.\n',
              'templates/worker/ci-fix.md':
                '# CI fix\n\n{{CI_ISSUES}}\n\n- [ ] Apply the requested CI fix.\n',
              'templates/worker/review.md':
                '# Review\n\n- [ ] Review the change and write the requested feedback and structured result.\n',
              'templates/worker/review-fix.md':
                '# Review fix\n\n{{ISSUES}}\n\n- [ ] Apply the requested fix.\n',
            },
          };
        }),
      gatewayEnv: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${path.join(options.root, 'scripts/runner-validation/canary/recovery-faults.mjs')}`,
      },
      binFiles: (holds) => {
        writeFileSync(path.join(holds, 'recovery-fixture'), 'isolated');
        return { gh: recoveryGithub(holds) };
      },
      seeds: Object.fromEntries(names.map((name) => [`recovery-${name}`, SEED])),
      slotFiles: (_slot, fixture) => ({
        'packages/cli/bin/farmslot.mjs': `#!/usr/bin/env node\nprocess.env.FARMSLOT_ROOT=${JSON.stringify(fixture)};\nawait import(${JSON.stringify(path.join(options.root, 'packages/cli/bin/farmslot.mjs'))});\n`,
      }),
    });
    await writeFile(path.join(stack.holds, 'review'), 'swallow\n');
    return stack;
  };
  // Restarting a shared gateway interrupts unrelated cases. The teardown case owns
  // its restartable stack; all seven jobs can now finish without a cross-case barrier.
  const [sharedStack, teardownStack] = await Promise.all([
    startStack(
      RECOVERY_CASES.filter((name) => name !== 'interrupted-teardown'),
      options.evidence,
    ),
    startStack(['interrupted-teardown'], path.join(options.evidence, 'teardown-stack')),
  ]);
  jobs = RECOVERY_CASES.map(async (name) => {
    const t0 = Date.now();
    const stack = name === 'interrupted-teardown' ? teardownStack : sharedStack;
    const call = stack.call.bind(stack);
    const slotId = `recovery-${name}-1`;
    const repo = stack.slotRepo(slotId);
    const dir = path.join(options.evidence, name);
    await mkdir(dir, { recursive: true });
    let runId: string | undefined;
    let latest: Run | undefined;
    const phases: Record<string, number> = {};
    const answered = new Set<string>();
    const get = async () => {
      assert.ok(runId);
      latest = (await call<{ run: Run }>('run.get', { runId })).run;
      return latest;
    };
    const wait = async (
      description: string,
      predicate: (run: Run) => boolean | Promise<boolean>,
      budgetMs = 100_000,
    ) => {
      const began = Date.now();
      const until = Math.min(started + 110_000, began + budgetMs);
      try {
        for (;;) {
          signal.throwIfAborted();
          let changed = false;
          let wake: () => void = () => {};
          const notification = new Promise<void>((resolve) => {
            wake = () => {
              changed = true;
              resolve();
            };
          });
          signal.addEventListener('abort', wake, { once: true });
          const unsubscribe = stack.connection().onEvent((event) => {
            const payload = event.payload as {
              runId?: string;
              run?: { id?: string };
              slotId?: string;
              slot?: { slot?: string };
              changes?: Array<{ key: { runId?: string; slotId?: string } }>;
            };
            if (
              payload?.runId === runId ||
              payload?.run?.id === runId ||
              payload?.slotId === slotId ||
              payload?.slot?.slot === slotId ||
              payload?.changes?.some(({ key }) => key.runId === runId || key.slotId === slotId)
            )
              wake();
          });
          const watcher = watch(stack.holds, (_event, file) => {
            if (file && /\.hit$|\.timeout\.json$|^review\.env-/.test(String(file))) wake();
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const run = await get();
            if (await predicate(run)) return run;
            if (
              run.status === 'failed' &&
              !run.steps.some((step) => step.status === 'running' || step.status === 'pending')
            )
              throw new Error(
                `${description}: ${run.error ?? run.steps.find((step) => step.status === 'failed')?.detail ?? 'run failed'}`,
              );
            if (Date.now() >= until)
              throw new Error(
                `${description}: deadline; ${run.status}; ${run.error ?? ''}; ${run.steps.map((step) => `${step.name}:${step.status}:${step.detail ?? ''}`).join(' ')}`,
              );
            if (!changed)
              await Promise.race([
                notification,
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, Math.max(1, until - Date.now()));
                }),
              ]);
          } finally {
            signal.removeEventListener('abort', wake);
            unsubscribe();
            watcher.close();
            if (timer) clearTimeout(timer);
          }
        }
      } finally {
        phases[description] = Date.now() - began;
      }
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    const answer = async (run: Run, issues = false) => {
      const context = run.agentContexts?.find(
        (c) =>
          c.role === 'review' &&
          ['working', 'launching', 'waiting'].includes(c.status) &&
          c.nativeSession?.acceptedAt &&
          !answered.has(c.id),
      );
      if (!context?.taskFile || !context.signalFile || !context.reviewResultFile) return false;
      const envFile = path.join(stack.holds, `review.env-${context.runnerSessionId}.json`);
      if (!existsSync(envFile)) return false;
      answered.add(context.id);
      const taskDir = path.join(repo, path.dirname(context.taskFile));
      const finding = {
        file: 'scripted-change.txt',
        line: 1,
        description: 'Apply the next fixture revision.',
        severity: 'major',
      };
      await writeFile(
        path.join(taskDir, 'artifacts', `review-feedback.${context.id}.md`),
        `# Review\n\n## Verdict: ${issues ? 'ISSUES' : 'PASS'}\n\n## Summary\nFixture review.\n\n## Issues\n${issues ? '- **scripted-change.txt:1** Apply the next fixture revision.' : ''}\n\n## Follow-ups\n- None.\n`,
      );
      await writeFile(
        path.join(taskDir, context.reviewResultFile),
        JSON.stringify({
          schemaVersion: 1,
          verdict: issues ? 'issues' : 'pass',
          issues: issues ? [finding] : [],
        }),
      );
      const env = JSON.parse(await readFile(envFile, 'utf8')) as NodeJS.ProcessEnv;
      await exec(
        path.join(taskDir, 'mark'),
        [
          '--checklist',
          path.basename(context.taskFile),
          '--signal',
          path.basename(context.signalFile),
          'complete',
          '--mark-last',
        ],
        { cwd: repo, env, signal, timeout: 8000 },
      );
      await writeJson(path.join(dir, `${context.id}-answer.json`), {
        context,
        signal: JSON.parse(await readFile(path.join(repo, context.signalFile), 'utf8')),
      });
      await writeFile(
        path.join(stack.holds, `review.complete-${context.runnerSessionId}`),
        'complete',
      );
      return true;
    };
    const context = {
      name,
      slotId,
      repo,
      dir,
      stack,
      call,
      get,
      wait,
      git,
      answer,
      phases,
      async start(extra: Record<string, unknown> = {}) {
        const start = Date.now();
        const result = await call<{ run: Run }>('run.create', {
          ...canaryRunParams(slotId, name),
          project: `recovery-${name}`,
          initialContext: 'Deterministic recovery fixture.',
          scripted: {
            mode: 'scenario',
            scenario: 'late-ack',
            stepDelayMs: name === 'deferred-fix-active' ? 150 : 1,
          },
          ...([
            'deferred-fix-active',
            'review-cap',
            'silent-reviewer',
            'out-of-band-commit',
          ].includes(name)
            ? {
                reviewMode: 'cold',
                reviewValidationDepth: 'static-code',
                reviewSequence: [
                  { runner: 'codex', model: 'gpt-6-luna', effort: 'low', mode: 'cold' },
                ],
              }
            : {}),
          ...extra,
        });
        runId = result.run.id;
        phases.create = Date.now() - start;
        return result.run;
      },
      async replay(stepName: string) {
        assert.ok(runId);
        const began = Date.now();
        for (;;) {
          signal.throwIfAborted();
          try {
            return await call('run.replayStep', { runId, stepName });
          } catch (error) {
            // A failed step publishes before its cleanup ends. Retry only that explicit fence.
            if (
              !(error instanceof Error) ||
              !error.message.includes(
                'Run is finishing terminal cleanup; retry replay after cleanup settles',
              ) ||
              Date.now() - began > 10_000
            )
              throw error;
          }
        }
      },
      async resolve(decision: Run['decisions'][number], actionId: string) {
        return call('run.resolveDecision', { runId, decisionId: decision.id, actionId });
      },
      async scripted(scenario: string) {
        const run = await get();
        assert.ok(run.taskFile);
        const task = path.join(
          repo,
          '.task',
          path.basename(path.dirname(run.taskFile)),
          'external',
        );
        await mkdir(task, { recursive: true });
        await exec(
          process.execPath,
          [
            path.join(options.root, 'packages/cli/bin/farmslot.mjs'),
            'scripted-runner',
            '--mode',
            'scenario',
            '--scenario',
            scenario,
            '--step-delay-ms',
            '1',
            '--task-dir',
            task,
          ],
          {
            cwd: repo,
            env: {
              ...process.env,
              FARMSLOT_ROOT: stack.fixture,
              FARMSLOT_ENABLE_SCRIPTED_SCENARIOS: '1',
            },
            timeout: 3000,
          },
        );
      },
    };
    let differences: string[] = [];
    try {
      const scenario = await import(`../scenarios/${name}.mjs`);
      await scenario.runScenario(context);
    } catch (error) {
      differences = [error instanceof Error ? error.message : String(error)];
      if (
        error instanceof Error &&
        'stdout' in error &&
        typeof error.stdout === 'string' &&
        error.stdout.trim()
      )
        differences.push(error.stdout);
      if (error instanceof Error && 'code' in error) differences.push(`code=${error.code}`);
      if (error instanceof Error && 'signal' in error) differences.push(`signal=${error.signal}`);
    }
    try {
      if (existsSync(path.join(repo, '.agent'))) {
        const { cp } = await import('node:fs/promises');
        await cp(path.join(repo, '.agent'), path.join(dir, 'session'), { recursive: true });
      }
      if (runId) {
        await get();
        await writeJson(path.join(dir, 'run-final.json'), latest);
        if (latest?.status === 'ci-watching' || latest?.status === 'monitoring')
          await call('run.pause', { runId });
      }
    } catch (error) {
      differences.push(
        `Evidence cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const durationS = (Date.now() - t0) / 1000;
    const timingsS = latest ? stepTimings(latest) : {};
    const check: CheckResult = {
      case: name,
      variant: 'main',
      target: 'isolated',
      status: differences.length ? 'fail' : 'pass',
      model: 'scripted',
      modelCalls: 0,
      runId,
      durationS,
      timingsS,
      differences,
      observations:
        durationS > 5
          ? [`SLOW ${durationS}s: ${JSON.stringify(timingsS)}; phases=${JSON.stringify(phases)}`]
          : [],
      evidence: dir,
    };
    await options.log(`${name}: ${check.status}${durationS > 5 ? ' SLOW' : ''}`, {
      wallMs: Math.round(durationS * 1000),
      timingsS,
      phases,
      differences,
    });
    options.onCheck(check);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(jobs),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = new Error('Recovery matrix exceeded 120000ms');
            controller.abort(error);
            reject(error);
          },
          Math.max(1, 120_000 - (Date.now() - started)),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort(new Error('Recovery matrix finished'));
    await Promise.allSettled(jobs);
  }
  for (const stack of [sharedStack, teardownStack]) {
    const modelCalls = path.join(stack.holds, 'model-calls.log');
    assert.ok(
      !existsSync(modelCalls) || !(await readFile(modelCalls, 'utf8')).trim(),
      'Recovery fixture issued a model request',
    );
  }
  if (Date.now() - started > 120_000) throw new Error('Recovery matrix exceeded 120000ms');
}
