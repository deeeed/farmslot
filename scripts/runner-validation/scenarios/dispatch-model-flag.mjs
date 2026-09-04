import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'dispatch-model-flag';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof that a dispatch carries the operator's selected model to the
 * runner CLI. Pools whose `dispatch_cmd` is runner-aware but has no `{model}`
 * placeholder (for example `cd {repo} && {runner_path} {safety_flags}`) used to
 * drop the selection silently, so the runner started on its own default and
 * only the TUI revealed the wrong model.
 *
 * This asserts on the persisted launch command the gateway actually ran, not on
 * pane text: `dispatch.outputs.launchCommand` is the same string tmux received.
 */
function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${method} failed`);
  }
  return JSON.parse(result.stdout);
}

async function poll(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out; latest=${JSON.stringify(latest)}`);
}

/**
 * Mirrors `quoteRunnerArgValue` in packages/slot-config: a shell-inert token is
 * passed through, anything else is single-quoted. Kept as an independent
 * expectation so the scenario asserts the contract, not the implementation.
 */
function expectedModelArgument(model) {
  if (/^[A-Za-z0-9._:@/+-]+$/.test(model)) return model;
  return `'${model.replace(/'/g, `'\\''`)}'`;
}

export async function runScenario({ timeoutMs, outDir, slotId, model, runner, taskFile }) {
  const reportRunner = runner || 'cursor';
  const report = {
    runner: reportRunner,
    slotId: slotId ?? null,
    model: model ?? null,
    runId: null,
    dispatchStatus: null,
    launchCommand: null,
    expectedModelArgument: null,
    modelFlagCount: 0,
    pass: false,
    error: null,
  };
  let runId = null;

  try {
    if (!slotId) throw new Error('dispatch-model-flag requires --slot <slotId>');
    if (!model) throw new Error('dispatch-model-flag requires --model <model>');
    if (!runner) throw new Error('dispatch-model-flag requires --runner <runner>');

    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;

    const expected = expectedModelArgument(model);
    report.expectedModelArgument = expected;

    // Interactive dev create: the gateway mints its own local dev ref from
    // `initialContext`, so this needs no Jira key that matches the project repo.
    const created = rpc('run.create', {
      project: slot.project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'dispatch model flag validation',
      initialContext:
        'Validation run for the dispatch model flag. Report the active model and stop; make no changes.',
      runner,
      model,
      slotId,
      skipPrepare: true,
      ...(taskFile ? { taskFile } : {}),
    });
    runId = created.run.id;
    report.runId = runId;

    const settled = await poll(
      () => rpc('run.get', { runId }).run,
      (state) => {
        const dispatch = state.steps.find((step) => step.name === 'dispatch');
        if (dispatch?.outputs?.launchCommand) return true;
        return ['failed', 'blocked', 'done', 'cancelled'].includes(state.status);
      },
      timeoutMs,
    );
    const dispatch = settled.steps.find((step) => step.name === 'dispatch');
    report.dispatchStatus = dispatch?.status ?? null;
    report.launchCommand = dispatch?.outputs?.launchCommand ?? null;
    report.terminalStatus = settled.status;
    report.terminalError = settled.error ?? null;

    if (!report.launchCommand) {
      throw new Error(
        `dispatch recorded no launchCommand (status=${settled.status}, dispatch=${report.dispatchStatus})`,
      );
    }
    const occurrences = report.launchCommand.match(/--model\s+\S+/g) ?? [];
    report.modelFlagCount = occurrences.length;
    if (!report.launchCommand.includes(`--model ${expected}`)) {
      throw new Error(`launch command does not carry --model ${expected}: ${report.launchCommand}`);
    }
    if (occurrences.length !== 1) {
      throw new Error(`expected exactly one --model argument, found ${occurrences.length}`);
    }
    if (report.dispatchStatus !== 'done') {
      throw new Error(`dispatch step is ${report.dispatchStatus}, expected done`);
    }
    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (runId) {
      try {
        rpc('run.cancel', { runId, reason: `${SCENARIO_ID} validation complete` });
        report.cancelled = true;
      } catch (cancelError) {
        // Advisory: the assertions above already ran. Surface the leak instead
        // of hiding it so the operator can release the slot by hand.
        report.cancelled = false;
        report.cancelError = cancelError?.message || String(cancelError);
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
