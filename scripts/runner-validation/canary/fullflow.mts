// Real inference on the disposable remote-node stack, with the production project contracts.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { cancelledRunSlotHold, isTerminalRunStatus, runOutputCloseUnavailableReason, type BacklogCreateResult, type BacklogEnqueueResult, type BacklogListResult, type NativeSessionReadResult, type Run, type RunCancelResult, type SlotReleaseResult, type SlotStatus } from '../../../packages/protocol/src/index.js';
import { writeJson } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import { FULLFLOW_MODEL, FULLFLOW_PROJECT, FULLFLOW_SEED, fullflowPack } from './fullflow-fixture.mjs';
import { REVIEWER } from './fixtures.mjs';
import { fullflowCloseAction, fullflowFailure, fullflowGateFailure, fullflowNativeFailure, fullflowTerminal, fullflowTimings } from './fullflow-outcome.js';
import type { IsolatedOptions } from './isolated.mjs';
import { failureText, type CheckResult } from './outcome.mjs';
import { driveRun, readSlot, retire } from './run-driver.mjs';
import { fullflowScopeAudit } from './fullflow-scope.mjs';

export const FULLFLOW_CASES = ['fix-bug', 'qa'] as const;
type FullflowCase = (typeof FULLFLOW_CASES)[number];
type Worker = { runner: string; model: string };
interface PiTurnReceipt { cwd: string; usage?: { totalTokens?: number }; stopReason?: string }
type FullflowOptions = Pick<IsolatedOptions, 'root' | 'evidence' | 'log' | 'reaper' | 'ownerTag' | 'cliSnapshots' | 'cliSnapshot' | 'onCheck' | 'onCleanup'> & { cases?: readonly FullflowCase[]; worker?: Worker };

export async function runFullflow(options: FullflowOptions): Promise<void> {
  const { root, evidence, log } = options;
  // Import the actual recipe entry point before dispatch so an unbuilt dependency fails setup.
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(root, 'apps/command-center/scripts/agentic/run-recipe.mjs'))})`], { cwd: root, stdio: 'pipe' });
  const worker = options.worker ?? FULLFLOW_MODEL;
  const pack = await fullflowPack(root, worker);
  const cases = options.cases ?? FULLFLOW_CASES;
  const controller = new AbortController();
  let inFlight: Promise<void> | undefined;
  const agent = path.join(evidence, 'pi-agent');
  if (worker.runner === 'pi') {
    if (!process.env.LITELLM_API_KEY) throw new Error('LITELLM_API_KEY is not set in the login shell');
    await mkdir(path.join(agent, 'extensions'), { recursive: true });
    // Disposable provider declaration, no subscription login or credential-file reads.
    await writeJson(path.join(agent, 'models.json'), { providers: { litellm: {
      baseUrl: 'https://litellm.consensys.info/v1', api: 'openai-completions', apiKey: '$LITELLM_API_KEY',
      models: [{ id: 'deepseek-v4p1-flash', name: 'DeepSeek V4.1 Flash', reasoning: true,
        contextWindow: 1048576, maxTokens: 131072, cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 } }],
    } } });
    // Bound Pi inference independently of the 25/15-minute case deadlines.
    await writeFile(path.join(agent, 'extensions', 'canary.ts'), `import { appendFileSync } from 'node:fs';
export default function(pi) {
  let turns = 0;
  pi.on('turn_end', (event, ctx) => {
    appendFileSync(${JSON.stringify(path.join(evidence, 'pi-turns.jsonl'))}, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, cwd: ctx.cwd, usage: event.message.usage, stopReason: event.message.stopReason }) + '\\n');
    if (++turns >= 150) ctx.abort();
  });
}
`);
  }
  const realClaude = worker.runner === 'claude'
    ? execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() : undefined;
  const manifest = await readFile(path.join(root, 'docs/examples/recipes/farmslot-v1.action-manifest.json'), 'utf8');
  const stack = await startRemoteNodeStack({
    ...options,
    onCleanup: (stop) => options.onCleanup?.(async () => {
      // Keep RPC alive until every case has captured its final timings and first failure.
      controller.abort();
      const errors: string[] = [];
      try { await inFlight; } catch (error) { errors.push(`case finalization: ${String(error)}`); }
      return [...errors, ...await stop()];
    }),
    nodeEnv: worker.runner === 'pi' ? { LITELLM_API_KEY: process.env.LITELLM_API_KEY, PI_CODING_AGENT_DIR: agent } : {},
    machine: 'fullflow',
    slots: cases.map((name) => `${FULLFLOW_PROJECT}-${name}-1`),
    projects: () => [pack],
    seeds: { [FULLFLOW_PROJECT]: FULLFLOW_SEED },
    slotFiles: () => ({
      // A last guard even if a model ignores the task's local-only publication instruction.
      '.git/hooks/pre-push': '#!/bin/sh\necho "fullflow: push is disabled" >&2\nexit 1\n',
      // Slot-local adapters keep pack references portable; all execution stays in the real wrapper.
      '.fullflow/action-manifest.json': manifest,
      '.fullflow/validate-recipe.sh': `#!/bin/sh\nexport FARMSLOT_SLOT_REPO="$PWD"\nexec bash '${root}/projects/farmslot-farm/setup/validate-recipe.sh' "$@"\n`,
      '.fullflow/run-recipe.mjs': `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(process.execPath, [${JSON.stringify(path.join(root, 'apps/command-center/scripts/agentic/run-recipe.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exit(r.status ?? 1);\n`,
    }),
    binFiles: (holds): Record<string, string> => realClaude ? ({
      // Transparent real runner with a bounded turn count; no fake model output.
      claude: `#!/bin/sh\ncase " $* " in *" --print "*) printf '%s\\n' invocation >> '${holds}/claude-calls'; exec '${realClaude}' "$@" --max-turns 100 ;; *) exec '${realClaude}' "$@" ;; esac\n`,
    }) : {},
    nodeBin: path.dirname(process.execPath),
  });
  await writeJson(path.join(evidence, 'derived-project.json'), pack.projectJson);

  for (const name of cases) {
    if (controller.signal.aborted) break;
    inFlight = (async () => {
      const started = Date.now();
      const slotId = `${FULLFLOW_PROJECT}-${name}-1`;
      const dir = path.join(evidence, name);
      await mkdir(dir, { recursive: true });
      const check: CheckResult = {
        case: name, variant: '-', target: 'isolated', status: 'fail',
        model: `${worker.runner} ${worker.model} worker + codex gpt-6-luna low reviewer`, modelCalls: 0,
        differences: [], observations: [], evidence: dir,
      };
      options.onCheck(check);
      let run: Run | undefined;
      let refreshed = false;
      let selectedClose: string | undefined;
      let held = false;
      const cursors = new Map<string, number>();
      const context = `Isolated fullflow canary. Work only in your tiny slot checkout and its generated task directory. Read-only support is limited to the task pin and ${root}. Never enumerate other checkouts or worktrees, inspect credentials, keys or logins, or contact live services, persistent Farmslot homes or foreign tmux servers. Never build or repair support tooling. On a missing prerequisite, retain its exact error and mark blocked. Never push, publish packages, post comments or contact GitHub. Keep all commits local. This tiny package has no app/runtime; use only CLI command assertions and npm test for CI. Stop and mark blocked with the exact engine message if task-bound baseline/acceptance commands refuse evidence. Never edit task tooling or alter baseline history to bypass a refusal.`;
      try {
        const result = await driveRun({
          call: stack.call, log, label: `fullflow ${name}`, dir, slotId,
          shape: {
            project: FULLFLOW_PROJECT,
            timeoutMs: (name === 'fix-bug' ? 25 : 15) * 60_000,
            ...(name === 'fix-bug' ? { start: async () => {
              const { item } = await stack.call<BacklogCreateResult>('backlog.create', {
                project: FULLFLOW_PROJECT, sourceKind: 'manual', flowType: 'fix-bug', status: 'ready',
                title: 'Fix sum CLI subtraction', autoDispatch: false, allowedSlots: [slotId], ...worker,
                mode: 'autonomous', reviewMode: 'cold', reviewSequence: [{ ...REVIEWER, mode: 'cold' }],
                notes: `${context}\n\nnode cli.mjs 2 3 prints -1; it must print 5. Fix src/sum.mjs with one minimal edit. Retain a failing task-bound baseline recipe before editing and the passing recipe after. Use the real template and every generated acceptance command.\n\n## Acceptance Criteria\n- The public command node cli.mjs 2 3 prints 5.`,
              });
              const queued = await stack.call<BacklogEnqueueResult>('backlog.enqueue', { itemId: item.id });
              await writeJson(path.join(dir, 'intake.json'), queued);
              const deadline = Date.now() + 90_000;
              for (;;) {
                controller.signal.throwIfAborted();
                const { items } = await stack.call<BacklogListResult>('backlog.list', { project: FULLFLOW_PROJECT });
                const current = items.find((candidate) => candidate.id === item.id);
                if (current?.runId) return (await stack.call<{ run: Run }>('run.get', { runId: current.runId })).run;
                if (current?.lastDispatchError) throw new Error(current.lastDispatchError);
                if (Date.now() > deadline) throw new Error('backlog.enqueue: no run created within 90 seconds');
                await delay(200);
              }
            } } : {}),
            create: () => ({
              project: FULLFLOW_PROJECT, slotId, ...worker, transport: 'native', modelQuestions: 'off',
              // Tiny-repo scope guidance; the real QA template and artifact contract still own completion.
              initialContext: `${context} QA scope is solely the version CLI criterion on this seed, not the canary implementation. Use the generated TASK.md QA contract and actual smoke results for the suite/report. Keep helper scripts under the task directory so installed SDK imports resolve; never place them in /tmp. Write the required learnings.md and retrospective.md before the completion finalizer. Do not inspect framework implementation unless a generated contract is missing necessary information.`,
              mode: 'validation', flowType: 'qa', ticketOrPr: 'main', qaProfileId: 'pr',
              qaInputs: { scope: { kind: 'ref', ref: 'main' }, criteria: ['node cli.mjs --version prints 1.0.0.'] },
              completionPolicy: 'artifact-only',
            }),
            decide: (decision, current) => {
              if (name === 'qa' && runOutputCloseUnavailableReason(current)) return undefined;
              if (name === 'fix-bug' && (selectedClose || decision.type !== 'engine_human_gate')) return undefined;
              const action = name === 'qa' || refreshed ? fullflowCloseAction(decision) : undefined;
              if (action) {
                selectedClose = action;
                check.observations.push(`${decision.type}: offered: ${decision.actions.map((item) => item.id).join(', ')}; taken: ${action}`);
              }
              return action ? { resolve: action } : undefined;
            },
            onPoll: async (call, current) => {
              run = current;
              await writeJson(path.join(dir, 'run-latest.json'), current);
              for (const ctx of current.agentContexts ?? []) {
                const binding = ctx.nativeSession;
                if (!binding?.generation) continue;
                let more = true;
                while (more) {
                  const page = await call<NativeSessionReadResult>('native.session.read', {
                    sessionId: binding.sessionId, executionNodeId: binding.executionNodeId,
                    after: cursors.get(ctx.id) ?? 0, limit: 500,
                    worker: { runId: current.id, contextId: ctx.id, generation: binding.generation, leaseId: binding.leaseId },
                  });
                  await appendFile(path.join(dir, 'native-events.jsonl'), page.events.map((event) => JSON.stringify(event) + '\n').join(''));
                  cursors.set(ctx.id, page.cursor);
                  const failure = fullflowNativeFailure(current, page.events);
                  if (failure) { check.error ??= failure; throw new Error(failure); }
                  more = page.hasMore;
                }
              }
              const failure = selectedClose && current.status === fullflowTerminal(selectedClose) ? undefined : fullflowFailure(current);
              if (failure) { check.error ??= failure; throw new Error(failure); }
              controller.signal.throwIfAborted();
              const gate = current.decisions.find((item) => item.type === 'engine_human_gate' && !item.resolvedAt);
              // The engine re-presents HUMAN_GATE after hold, with FINALIZE still pending.
              if (selectedClose === 'hold' && !held && current.status === 'human-gating' && gate
                && current.decisions.some((item) => item.type === 'engine_human_gate' && item.resolvedAt && item.resolvedAction === 'hold')
                && current.steps.some((step) => step.name === 'human-gate' && step.status === 'running')
                && current.steps.some((step) => step.name === 'finalize' && step.status === 'pending')) {
                await writeJson(path.join(dir, 'gate-held.json'), current);
                held = true;
                check.observations.push('hold accepted: human-gating, replacement gate open, human-gate running, finalize pending; public run.cancel used for cleanup.');
                const cancelled = await call<RunCancelResult>('run.cancel', { runId: current.id, reason: 'canary: held publication verified; test cleanup' });
                await writeJson(path.join(dir, 'cancel.json'), cancelled);
                Object.assign(current, cancelled.run);
                const failed = cancelled.effects?.filter((effect) => effect.status === 'failed') ?? [];
                if (failed.length) throw new Error(`run.cancel: ${failed.map((effect) => `${effect.name}: ${effect.detail}`).join('; ')}`);
                const { fleet } = await call<{ fleet: { slots: SlotStatus[] } }>('fleet.status');
                const kept = fleet.slots.find((slot) => slot.slot === slotId);
                await writeJson(path.join(dir, 'slot-kept-for-replay.json'), kept);
                const hold = kept && cancelledRunSlotHold(kept);
                if (!hold || hold.runId !== current.id) throw new Error(`cancel retention: slot is not held for run ${current.id}`);
                const message = `[run-lifecycle] kept slot ${slotId} for cancelled run ${current.id}`;
                const lifecycle = (await readFile(path.join(evidence, 'gateway-1.log'), 'utf8')).split('\n').filter((line) => line.includes(message));
                await writeJson(path.join(dir, 'cancel-lifecycle-log.json'), lifecycle);
                if (!lifecycle.length) throw new Error(`cancel retention: lifecycle log missing: ${message}`);
                // The operator release resets local work; retain task proof before that reset.
                if (current.taskFile) await cp(path.dirname(current.taskFile), path.join(dir, 'task'), { recursive: true });
                const release = await call<SlotReleaseResult>('slot.release', hold.releaseParams);
                await writeJson(path.join(dir, 'slot-release.json'), { params: hold.releaseParams, result: release });
                if (!release.released) throw new Error(`slot.release: ${release.reason ?? 'release refused'}`);
                check.observations.push(`cancel kept slot held/occupied for run ${current.id}, confirmed by lifecycle log; operator slot.release accepted.`);
              }
              if (gate && !refreshed) {
                const t0 = Date.now();
                const refresh = await call<{ run: Run }>('run.refreshPublishPackage', { runId: current.id, decisionId: gate.id });
                await writeJson(path.join(dir, 'package-refresh.json'), refresh);
                const ready = refresh.run.decisions.find((item) => item.type === 'engine_human_gate' && !item.resolvedAt);
                if (ready?.payload?.kind !== 'ready' || !ready.payload.prPackage)
                  throw new Error('publish-package-refresh: no prepared package in refreshed gate');
                check.timingsS = { 'publish-package-refresh': (Date.now() - t0) / 1000 };
                refreshed = true;
                // Refresh can replace the gate. Decide against its current offered actions.
                Object.assign(current, refresh.run);
                const failure = fullflowGateFailure(ready);
                if (failure) { check.error ??= failure; throw new Error(failure); }
              }
            },
          },
          hooks: {
            onCreated: (id) => { check.runId = id; },
            // Real inference can spend six minutes in one step; the case deadline owns its cap.
            holding: () => Boolean(run && !isTerminalRunStatus(run.status) && !run.decisions.some((decision) => !decision.resolvedAt)),
          },
        });
        run = result.run;
        check.differences.push(...result.refused);
        const required = name === 'fix-bug'
          ? ['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor', 'review', 'complete']
          : ['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor', 'human-gate', 'complete'];
        for (const step of required)
          if (!run.steps.some((item) => item.name === step && item.status === 'done'))
            check.differences.push(`${step}: did not complete`);
        if (name === 'fix-bug' && !refreshed) check.differences.push('publish-package-refresh: not reached');
        if (name === 'fix-bug' && !run.steps.some((step) => step.name === 'human-gate' && step.startedAt))
          check.differences.push('human-gate: not reached');
        if (name === 'qa' && (!run.taskFile || !existsSync(path.join(path.dirname(run.taskFile), 'artifacts/report.html'))))
          check.differences.push('qa-report: report.html not retained');
        if (name === 'fix-bug' && (!held || selectedClose !== 'hold')) check.differences.push('gate: offered hold was not accepted into the held state');
        if (selectedClose && !run.decisions.some((decision) => decision.resolvedAt && decision.resolvedAction === selectedClose))
          check.differences.push(`gate: ${selectedClose} resolution not recorded`);
        if (run.status !== fullflowTerminal(selectedClose)) check.differences.push(`run: ${run.status}`);
        if (result.outcome.slot !== 'ready/-') check.differences.push(`release: ${result.outcome.slot}`);
        check.observed = result.outcome;
        check.status = check.differences.length ? 'fail' : 'pass';
      } catch (error) {
        // Last successful read preserves product failures even if an interrupt arrived afterward.
        check.error ??= fullflowFailure(run ?? { steps: [], decisions: [] })
          ?? (controller.signal.aborted ? `${run?.steps.find((step) => step.status === 'running')?.name ?? 'intake'}: interrupted` : error instanceof Error ? error.message : String(error));
        check.differences.unshift(check.error);
      } finally {
        const ended = Date.now();
        if (run) {
          check.failureText = check.error ?? failureText(run);
          check.timingsS = { ...fullflowTimings(run, ended), ...check.timingsS };
          check.modelCalls = (run.sessionUsage ?? []).reduce((sum, usage) => sum + (usage.turns ?? 0), 0);
          const receiptsFile = path.join(evidence, 'pi-turns.jsonl');
          if (worker.runner === 'pi' && existsSync(receiptsFile)) {
            const receipts: PiTurnReceipt[] = (await readFile(receiptsFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
            const scoped = receipts.filter((receipt) => receipt.cwd === stack.slotRepo(slotId));
            check.modelCalls = scoped.length + (run.sessionUsage ?? []).filter((usage) => usage.runner !== 'pi').reduce((sum, usage) => sum + (usage.turns ?? 0), 0);
            await writeJson(path.join(dir, 'pi-turns.json'), scoped);
          }
          check.observations.push('modelCalls counts recorded Pi inference turns when available, otherwise gateway usage turns; absent receipts do not prove zero provider requests.');
          await writeJson(path.join(dir, 'run-final.json'), run);
          await writeJson(path.join(dir, 'usage.json'), run.sessionUsage ?? []);
          const task = run.taskFile && path.dirname(run.taskFile);
          if (task && existsSync(task)) await cp(task, path.join(dir, 'task'), { recursive: true });
          const runtime = path.join(stack.slotRepo(slotId), '.sandbox/farmslot-farm');
          if (existsSync(runtime)) await cp(runtime, path.join(dir, 'slot-runtime'), { recursive: true });
          const retired = await retire(stack.call, run.id);
          if (retired) { check.status = 'fail'; check.differences.push(`cleanup: ${retired}`); }
          await writeJson(path.join(dir, 'slot-after-close.json'), await readSlot(stack.call, slotId));
        }
        check.durationS = Math.round((Date.now() - started) / 100) / 10;
        const sessions = path.join(agent, 'sessions');
        const sessionFiles = existsSync(sessions) ? (await readdir(sessions, { recursive: true })).filter((file) => file.endsWith('.jsonl')).map((file) => path.join(sessions, file)) : [];
        const native = path.join(dir, 'native-events.jsonl');
        const sources = [...sessionFiles, ...(existsSync(native) ? [native] : [])];
        const workerSessions = new Set(run?.agentContexts?.filter((ctx) => ctx.role !== 'review').map((ctx) => ctx.nativeSession?.sessionId));
        const audit = fullflowScopeAudit(await Promise.all(sources.map(async (file) => {
          const text = await readFile(file, 'utf8');
          return { file, text: file === native ? text.split('\n').filter((line) => line && workerSessions.has(JSON.parse(line).sessionId)).join('\n') : text };
        })), {
          slot: stack.slotRepo(slotId), task: run?.taskFile ? path.dirname(run.taskFile) : undefined,
          fixture: stack.fixture, home: path.join(stack.fixture, 'node-user-home'),
        });
        await writeJson(path.join(dir, 'scope-audit.json'), audit);
        check.observations.push(`Scope audit: ${audit.findings.length} outside path references in recorded worker tool calls; see scope-audit.json. Observations only; logs do not prove syscall coverage.`);
        await log(`fullflow ${name}: ${check.status}`, { differences: check.differences, durationS: check.durationS });
        await writeJson(path.join(dir, 'check.json'), check);
      }
    })();
    await inFlight;
  }
  const calls = path.join(stack.holds, 'claude-calls');
  if (existsSync(calls)) await writeFile(path.join(evidence, 'claude-invocations.txt'), await readFile(calls));
}
