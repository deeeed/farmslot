import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'runner-stop-process-scan';
export const RUNNER_AGNOSTIC = true;

/**
 * The runner-stop pane-tree liveness probe (MANUAL-000121).
 *
 * Three claims, each proved against something real rather than a mock:
 *
 *  1. Fail-before / pass-after. The same executor runs against `origin/main`
 *     and against the working tree, so the regression it fixes is demonstrated
 *     rather than described: on main a `ps` that did not happen produces the
 *     confirmed-absent signature, which is what lets a park release a slot out
 *     from under a live worker.
 *  2. Cost. The forks one probe of a branching pane tree actually spends,
 *     counted by shimming `ps` and `pgrep` onto PATH.
 *  3. The deployed gateway. A forced fleet refresh over the operator gateway's
 *     RPC runs this walk on every live slot and must come back with both
 *     verdicts the walk can reach: a runner found, and a runner confirmed gone.
 */
const BASELINE_REF = 'origin/main';
const DEFAULT_GATEWAY = 'ws://localhost:7801';

function runExecutor({ root, sourceRoot, sourceSha, resultPath }) {
  const executor = path.join(
    root,
    'scripts/runner-validation/gateway/runner-stop-process-scan.mts',
  );
  const stdout = execFileSync('yarn', ['exec', 'tsx', executor], {
    cwd: root,
    env: {
      ...process.env,
      FARMSLOT_VALIDATION_SOURCE_ROOT: sourceRoot,
      FARMSLOT_VALIDATION_SOURCE_SHA: sourceSha,
      FARMSLOT_VALIDATION_RESULT_PATH: resultPath,
    },
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    result: JSON.parse(fs.readFileSync(resultPath, 'utf-8')),
    log: stdout.trim().split('\n').slice(-20),
  };
}

function nodeById(result, id) {
  return result.nodes.find((node) => node.id === id) ?? null;
}

/**
 * Force the gateway to re-derive every slot's agent state. That derivation is
 * `isRunnerAliveUnderPane`, which is the walk under test, so the verdicts that
 * come back are the deployed build's own answers on the live fleet.
 */
function probeGatewayFleet(root) {
  const gateway = process.env.FARMSLOT_GATEWAY ?? DEFAULT_GATEWAY;
  const node = {
    id: 'gateway-rpc-reports-both-liveness-verdicts',
    claim:
      'a forced fleet.status refresh over the gateway returns both a found runner and a confirmed-absent one',
    gateway,
    pass: false,
    skipped: false,
    observed: null,
  };
  const startedAt = Date.now();
  let raw;
  try {
    raw = execFileSync(
      'node',
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        'fleet.status',
        '{"forceRefresh":true}',
      ],
      {
        cwd: root,
        env: { ...process.env, FARMSLOT_GATEWAY: gateway, FARMSLOT_RPC_TIMEOUT_MS: '600000' },
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    node.skipped = true;
    node.observed = {
      reason: `gateway RPC unreachable at ${gateway}`,
      detail: (error?.stderr || error?.message || String(error)).trim().split('\n').slice(-3),
    };
    return node;
  }
  const slots = JSON.parse(raw).fleet.slots;
  const counts = {};
  for (const slot of slots) counts[slot.agent] = (counts[slot.agent] ?? 0) + 1;
  node.observed = {
    elapsedMs: Date.now() - startedAt,
    verdictCounts: counts,
    working: slots.filter((slot) => slot.agent === 'working').map((slot) => slot.slot),
    idle: slots.filter((slot) => slot.agent === 'idle').map((slot) => slot.slot),
  };
  node.pass = (counts.working ?? 0) > 0 && (counts.idle ?? 0) > 0;
  return node;
}

export async function runScenario({ outDir }) {
  const runner = 'gateway';
  const root = process.cwd();
  fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(root, 'temp', 'runner-stop-process-scan-'));
  const baselineRoot = path.join(tempRoot, 'baseline');
  const report = {
    runner,
    baselineRef: BASELINE_REF,
    baselineSha: null,
    currentSha: null,
    /** True when the measured tree carried uncommitted work, so currentSha is not the whole story. */
    currentTreeDirty: null,
    baseline: null,
    current: null,
    baselineLog: [],
    currentLog: [],
    gatewayNode: null,
    failBefore: false,
    passAfter: false,
    pass: false,
    error: null,
  };

  try {
    const baselineSha = execFileSync('git', ['rev-parse', BASELINE_REF], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    report.baselineSha = baselineSha;
    fs.mkdirSync(baselineRoot, { recursive: true });
    const archive = execFileSync('git', ['archive', baselineSha], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync('tar', ['-x', '-C', baselineRoot], {
      input: archive,
      maxBuffer: 256 * 1024 * 1024,
    });

    const baseline = runExecutor({
      root,
      sourceRoot: baselineRoot,
      sourceSha: baselineSha,
      resultPath: path.join(tempRoot, 'baseline-result.json'),
    });
    // Stamp what was actually measured. The scan runs against the WORKING TREE,
    // so naming HEAD alone would overclaim whenever the tree carries uncommitted
    // work — which is exactly when this scenario is most often run.
    report.currentSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    report.currentTreeDirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf-8',
      }).trim().length > 0;
    const current = runExecutor({
      root,
      sourceRoot: root,
      sourceSha: report.currentSha,
      resultPath: path.join(tempRoot, 'current-result.json'),
    });

    report.baseline = baseline.result;
    report.current = current.result;
    report.baselineLog = baseline.log;
    report.currentLog = current.log;
    // The regression has to be visible on main, or this proves nothing: an
    // undecidable probe there must still carry the confirmed-absent signature.
    report.failBefore =
      nodeById(baseline.result, 'a-failed-ps-is-not-a-confirmed-absence')?.pass === false &&
      nodeById(baseline.result, 'one-probe-reads-the-process-table-once')?.pass === false;
    report.passAfter = current.result.pass === true;
    report.gatewayNode = probeGatewayFleet(root);
    // A gateway we could not reach is a proof we did not get, not a proof we
    // may skip. The reason is recorded either way, but the scenario fails.
    report.pass = report.failBefore && report.passAfter && report.gatewayNode.pass === true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const outPath = writeEvidence(report, SCENARIO_ID, runner, outDir);
  return { scenario: SCENARIO_ID, runner, outPath, pass: report.pass, report };
}
