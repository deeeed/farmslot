import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { ROOT, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'resource-posture-smoke';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof of the ADR-054 run resource posture through the production
 * gateway: a real run acquires a real project capability through the same
 * `runtime.capability.acquire` RPC the worker uses, then `runtime.posture.apply`
 * drives that run through `operator-wait` and `terminal` while
 * `runtime.posture.status` reports desired disposition against observed
 * provider state.
 *
 * It asserts on gateway RPC results and the persisted run record, never on pane
 * text. The run is a scripted interactive-start dispatch so no LLM turn is
 * spent, and it is cancelled at the end with the same slot-release proof the
 * other dispatch scenarios use.
 *
 * Not covered live: chain retention when a provider's release action fails.
 * There is no way to induce a release failure on farmslot-farm without changing
 * project config, so that path stays unit-covered in registry.test.ts.
 *
 * Capability choice: `farmslot-farm` declares no `low` cost provider, so this
 * uses the cheapest one that is safe to drive live — `sandbox-gateway-ui`
 * (medium cost, shared, and its release action deliberately retains the
 * control-plane process). Medium and low take the same framework retain path at
 * `operator-wait`; only `high` is shed.
 */
const CAPABILITY_ID = 'sandbox-gateway-ui';

/** Booting a simulator plus Metro is minutes, not seconds. */
const SLOW_RPC_TIMEOUT_MS = 480_000;

function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  const stdout = result.stdout?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(
      `Gateway RPC ${method} failed (exit ${result.status}): ${result.stderr?.trim() || stdout || 'gateway unavailable'}`,
    );
  }
  return JSON.parse(stdout);
}

async function poll(description, read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

function capabilityState(status, capabilityId) {
  return status.state.capabilities.find((entry) => entry.capabilityId === capabilityId) ?? null;
}

/**
 * The shallowest, cheapest dependent pair in this slot's catalog. Chosen from
 * the live catalog rather than hardcoded so the scenario follows the project's
 * own configuration.
 *
 * "Shallowest" is load-bearing: `companion-native-client-ios -> ios-simulator`
 * costs the same by cost class as `ios-simulator -> companion-metro`, but the
 * first drags in a whole native client build. So a dependent that itself depends
 * on another dependent is never chosen — the pair must sit at depth 1, with a
 * dependency that has no dependencies of its own.
 */
function findDependentPair(capabilities) {
  const byId = new Map(capabilities.map((entry) => [entry.id, entry]));
  const cost = { low: 0, medium: 1, high: 2 };
  const available = (entry) => entry && entry.availability.state === 'available';
  const candidates = capabilities
    .filter((entry) => (entry.dependencies ?? []).length === 1)
    .map((entry) => ({ dependent: entry, dependency: byId.get(entry.dependencies[0]) }))
    .filter(
      (pair) =>
        available(pair.dependent) &&
        available(pair.dependency) &&
        // Depth 1 only: the dependency must be a leaf.
        (pair.dependency.dependencies ?? []).length === 0,
    );
  const totalCost = (pair) => cost[pair.dependent.cost.class] + cost[pair.dependency.cost.class];
  candidates.sort(
    (a, b) => totalCost(a) - totalCost(b) || a.dependent.id.localeCompare(b.dependent.id),
  );
  const chosen = candidates[0];
  if (!chosen) return null;
  return {
    ...chosen,
    why:
      `depth-1 pair with the lowest total cost class (${chosen.dependent.cost.class} + ` +
      `${chosen.dependency.cost.class}); rejected ${capabilities.filter((entry) => (entry.dependencies ?? []).length > 0).length - candidates.length} ` +
      'deeper or unavailable candidate(s)',
  };
}

/** Lifecycle event order is the Gateway's own record of what it stopped when. */
function releaseOrderFromEvents(status, capabilityIds) {
  return status.events
    .filter((event) => event.kind === 'released' && capabilityIds.includes(event.capabilityId))
    .map((event) => event.capabilityId);
}

/**
 * Acquire a capability that declares a dependency, drive the run through
 * `operator-wait` and `terminal`, and assert from `runtime.posture.status` that
 * both leases match policy and that the dependent stops before the dependency.
 *
 * Every dependent pair this project declares bottoms out at a device provider,
 * so this boots real resources. Set FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF=1 to
 * record it as skipped instead; the skip is reported, never silently passed.
 */
async function prepareDependencyPosture({ slotId, runId, report, acquireBudgetMs }) {
  const proof = { attempted: false, skipped: false, pass: false, reason: null, error: null };
  if (process.env.FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF === '1') {
    // The only way to legitimately not prove dependency ordering.
    proof.skipped = true;
    proof.reason = 'skipped by FARMSLOT_POSTURE_SKIP_DEPENDENCY_PROOF=1';
    return proof;
  }
  const catalog = rpc('runtime.capability.list', { slotId });
  const pair = findDependentPair(catalog.capabilities ?? []);
  if (!pair) {
    // Not a skip: the farm is expected to offer one, so its absence is a
    // finding about the fleet or the catalog, not a free pass.
    proof.error = `no available dependent capability pair in the ${report.project} catalog for ${slotId}`;
    return proof;
  }
  proof.attempted = true;
  proof.dependent = pair.dependent.id;
  proof.dependency = pair.dependency.id;
  proof.pairReason = pair.why;
  proof.candidates = (catalog.capabilities ?? [])
    .filter((entry) => (entry.dependencies ?? []).length > 0)
    .map((entry) => ({
      id: entry.id,
      dependencies: entry.dependencies,
      cost: entry.cost.class,
      availability: entry.availability.state,
    }));
  try {
    // Acquiring the dependent implicitly acquires its dependency. Booting a
    // simulator and Metro takes minutes, so this gets its own RPC budget; if the
    // client still gives up, the gateway may well be mid-acquire, so fall back
    // to polling lease state rather than declaring failure on a client timeout.
    let acquireError = null;
    try {
      const acquired = rpc(
        'runtime.capability.acquire',
        {
          slotId,
          capabilityId: pair.dependent.id,
          ownerRunId: runId,
          proofRequirement: {
            capabilityId: pair.dependent.id,
            reason: 'resource posture dependency validation',
            mode: 'state',
          },
        },
        Math.max(SLOW_RPC_TIMEOUT_MS, acquireBudgetMs),
      );
      if (!acquired.ok) {
        throw new Error(`acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`);
      }
    } catch (error) {
      acquireError = error?.message || String(error);
      proof.acquireClientError = acquireError;
    }

    // Lease state is the authority, not the RPC's return: the gateway keeps
    // acquiring after a client timeout.
    const acquiredLeases = await poll(
      `${pair.dependent.id} and ${pair.dependency.id} to reach acquired`,
      () => rpc('runtime.capability.status', { slotId, ownerRunId: runId }).leases,
      (leases) =>
        [pair.dependent.id, pair.dependency.id].every((id) =>
          leases.some((lease) => lease.capabilityId === id && lease.state === 'acquired'),
        ),
      acquireBudgetMs,
    ).catch((error) => {
      throw new Error(
        acquireError
          ? `${acquireError}; lease never reached acquired: ${error.message}`
          : error.message,
      );
    });
    proof.dependencyLeaseAcquired = acquiredLeases.some(
      (lease) => lease.capabilityId === pair.dependency.id && lease.state === 'acquired',
    );
    if (!proof.dependencyLeaseAcquired) {
      throw new Error(`acquiring ${pair.dependent.id} did not acquire ${pair.dependency.id}`);
    }

    // The pair is acquired right now and `operator-wait` is about to shed it, so
    // this is the only window in which a retained lease can be observed.
    proof.releaseRetained = assertCliReleaseRetained({
      slotId,
      runId,
      dependencyPair: { dependent: pair.dependent.id, dependency: pair.dependency.id },
    });
    if (!proof.releaseRetained.pass) {
      throw new Error(`CLI retained-release proof failed: ${proof.releaseRetained.error}`);
    }

    const waitApply = rpc(
      'runtime.posture.apply',
      { runId, posture: 'operator-wait', operationId: `${SCENARIO_ID}-dep-wait-${process.pid}` },
      SLOW_RPC_TIMEOUT_MS,
    );
    if (!waitApply.ok) {
      throw new Error(`operator-wait apply failed: ${JSON.stringify(waitApply.transition)}`);
    }
    const waitStatus = rpc('runtime.posture.status', { runId });
    proof.waitStates = [pair.dependent.id, pair.dependency.id].map((id) => {
      const state = capabilityState(waitStatus, id);
      if (!state) throw new Error(`posture status reported no state for ${id}`);
      return {
        capabilityId: id,
        desiredDisposition: state.desiredDisposition,
        observedState: state.observedState,
        policySource: state.policySource,
      };
    });
    for (const state of proof.waitStates) {
      // Desired and observed must agree: acquired/warm means a live provider,
      // stopped means a stopped one.
      const live = state.observedState === 'running';
      if (state.desiredDisposition === 'acquired' && !live) {
        throw new Error(
          `${state.capabilityId} is desired acquired but observed ${state.observedState}`,
        );
      }
      if (state.desiredDisposition === 'stopped' && state.observedState !== 'stopped') {
        throw new Error(
          `${state.capabilityId} is desired stopped but observed ${state.observedState}`,
        );
      }
    }

    // Setup only. `pass` stays false until the terminal verdict.
    proof.preparedAt = new Date().toISOString();
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
    // Whatever went wrong, anything this proof booted must still come down.
    // Recorded, not swallowed: the outcome lands in the evidence either way.
    try {
      const salvage = rpc(
        'runtime.posture.apply',
        { runId, posture: 'terminal', operationId: `${SCENARIO_ID}-dep-salvage-${process.pid}` },
        SLOW_RPC_TIMEOUT_MS,
      );
      proof.salvageTerminal = salvage.transition.outcome;
    } catch (salvageError) {
      proof.salvageTerminalError = salvageError?.message || String(salvageError);
    }
  }
  return proof;
}

/**
 * Pure verdict for the dependency pair's terminal state and release order.
 * Exported so the assertions can be exercised without a live gateway.
 */
export function evaluateDependencyTerminal({
  dependent,
  dependency,
  terminalStates,
  releaseOrder,
}) {
  for (const state of terminalStates) {
    if (state.desiredDisposition !== 'stopped' || state.observedState !== 'stopped') {
      return {
        pass: false,
        error: `${state.capabilityId} ended ${state.desiredDisposition}/${state.observedState}, expected stopped/stopped`,
      };
    }
  }
  const order = releaseOrder ?? [];
  const dependentAt = order.indexOf(dependent);
  const dependencyAt = order.lastIndexOf(dependency);
  if (dependentAt === -1 || dependencyAt === -1) {
    return { pass: false, error: `missing release events for the pair: ${order.join(', ')}` };
  }
  if (dependentAt > dependencyAt) {
    return {
      pass: false,
      error: `${dependency} was released before ${dependent}: ${order.join(', ')}`,
    };
  }
  return { pass: true, error: null };
}

/**
 * Terminal assertions for the dependency pair. Runs after the single `terminal`
 * apply that covers every capability this run holds, so one teardown proves the
 * whole set rather than each proof stopping its own providers.
 */
function assertDependencyTerminal({ slotId, runId, proof }) {
  if (!proof.attempted || proof.error) return proof;
  // `pass` is only ever set by the final verdict below, never earlier: an
  // assertion that fails here must not inherit a true left over from setup.
  proof.pass = false;
  try {
    const terminalStatus = rpc('runtime.posture.status', { runId });
    proof.terminalStates = [proof.dependent, proof.dependency].map((id) => {
      const state = capabilityState(terminalStatus, id);
      return {
        capabilityId: id,
        desiredDisposition: state?.desiredDisposition ?? null,
        observedState: state?.observedState ?? null,
      };
    });
    // The Gateway's own lifecycle events record the order it stopped them in.
    const capabilityStatus = rpc('runtime.capability.status', { slotId, ownerRunId: runId });
    proof.releaseOrder = releaseOrderFromEvents(capabilityStatus, [
      proof.dependent,
      proof.dependency,
    ]);
    const verdict = evaluateDependencyTerminal({
      dependent: proof.dependent,
      dependency: proof.dependency,
      terminalStates: proof.terminalStates,
      releaseOrder: proof.releaseOrder,
    });
    proof.pass = verdict.pass;
    proof.error = verdict.error;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * Run the workspace CLI (never a PATH `farmslot`) against the same gateway this
 * scenario drives, and return the parsed machine envelope with its exit code.
 */
function cli(args, timeoutMs = 120_000) {
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const entry = path.join(ROOT, 'packages/cli/src/entry.ts');
  const result = spawnSync(
    tsx,
    [entry, '--url', process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs },
  );
  const stdout = result.stdout?.trim() ?? '';
  return {
    status: result.status,
    stdout,
    stderr: result.stderr?.trim() ?? '',
    // spawnSync reports a missing binary or an enforced timeout here, not on the
    // exit status. Dropping it turned "python3 is not installed" and "the CLI
    // hung" into the same blank "printed nothing".
    spawnError: result.error
      ? `${result.error.code ?? result.error.name}: ${result.error.message}`
      : null,
  };
}

/**
 * The same CLI under a pseudo-terminal.
 *
 * The machine envelope is implied by a non-TTY stdout, so a piped run can never
 * exercise the human renderer. `pty-run.py` gives the child a real pty without
 * needing a controlling terminal, which is the only way to prove what an
 * operator actually reads.
 */
function cliHuman(args, timeoutMs = 120_000) {
  const result = spawnSync(
    'python3',
    [
      path.join(ROOT, 'scripts/runner-validation/lib/pty-run.py'),
      path.join(ROOT, 'node_modules', '.bin', 'tsx'),
      path.join(ROOT, 'packages/cli/src/entry.ts'),
      '--url',
      process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777',
      ...args,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error
      ? `${result.error.code ?? result.error.name}: ${result.error.message}`
      : null,
  };
}

function cliJson(args, timeoutMs = 120_000) {
  const run = cli([...args, '--json'], timeoutMs);
  if (!run.stdout) {
    throw new Error(
      `CLI \`farmslot ${args.join(' ')} --json\` printed nothing (exit ${run.status}): ${
        run.spawnError || run.stderr || 'no stderr'
      }`,
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(
      `CLI \`farmslot ${args.join(' ')} --json\` printed non-JSON: ${run.stdout.slice(0, 400)} (${error.message})`,
    );
  }
  return { ...run, envelope };
}

/**
 * Live proof of ADR-054 deliverable 9: the typed CLI commands read the same
 * Gateway result the RPCs return, and the human renderer never claims a stop the
 * Gateway did not observe.
 *
 * Every assertion compares CLI output against the RPC result taken at the same
 * moment, so this cannot pass by the CLI inventing plausible-looking state.
 */
function assertCliPostureSurface({ runId, capabilityId }) {
  const proof = { attempted: true, pass: false, error: null };
  try {
    // (a) `posture status --json` is the exact RPC result inside the envelope.
    const rpcStatus = rpc('runtime.posture.status', { runId });
    const statusRun = cliJson(['resource', 'posture', 'status', runId]);
    proof.statusExit = statusRun.status;
    proof.statusEnvelope = {
      command: statusRun.envelope.command,
      status: statusRun.envelope.status,
      exitCode: statusRun.envelope.exitCode,
    };
    if (statusRun.status !== 0 || statusRun.envelope.status !== 'ok') {
      throw new Error(`posture status --json exited ${statusRun.status}: ${statusRun.stdout}`);
    }
    if (statusRun.envelope.command !== 'resource.posture.status') {
      throw new Error(`envelope named the command ${statusRun.envelope.command}`);
    }
    const cliState = statusRun.envelope.data;
    if (cliState.runId !== runId) {
      throw new Error(`CLI reported run ${cliState.runId}, expected ${runId}`);
    }
    const cliCapability = (cliState.state?.capabilities ?? []).find(
      (entry) => entry.capabilityId === capabilityId,
    );
    const rpcCapability = capabilityState(rpcStatus, capabilityId);
    if (!cliCapability) throw new Error(`CLI status omitted ${capabilityId}`);
    proof.statusCapability = {
      desiredDisposition: cliCapability.desiredDisposition,
      observedState: cliCapability.observedState,
      policySource: cliCapability.policySource,
    };
    if (
      cliCapability.desiredDisposition !== rpcCapability.desiredDisposition ||
      cliCapability.observedState !== rpcCapability.observedState ||
      cliCapability.policySource !== rpcCapability.policySource
    ) {
      throw new Error(
        `CLI reported ${cliCapability.desiredDisposition}/${cliCapability.observedState}/${cliCapability.policySource} where the RPC reported ${rpcCapability.desiredDisposition}/${rpcCapability.observedState}/${rpcCapability.policySource}`,
      );
    }

    // (b) The human renderer, under a real pty, shows desired beside observed and
    // never prints an observed stop while the provider is running.
    const humanRun = cliHuman(['resource', 'posture', 'status', runId]);
    // Strip the SGR colour codes the pty enables so the lines can be matched.
    const humanLines = humanRun.stdout
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\r/g, '')
      .split('\n');
    // This capability's block: its headline plus the indented detail lines under
    // it, which carry the reason and policy source without repeating the id.
    // Scoping matters because a whole-output match lets another capability's row
    // satisfy — or wrongly fail — an assertion about this one.
    const headlineIndex = humanLines.findIndex(
      (line) => line.includes(capabilityId) && line.includes('wants='),
    );
    const capabilityLines = [];
    if (headlineIndex >= 0) {
      capabilityLines.push(humanLines[headlineIndex]);
      for (let index = headlineIndex + 1; index < humanLines.length; index += 1) {
        // Detail lines are indented deeper than the headline; the next headline
        // ends the block.
        if (!/^ {4}\S/.test(humanLines[index])) break;
        capabilityLines.push(humanLines[index]);
      }
    }
    proof.humanSample = capabilityLines.join(' | ').trim();
    if (!humanRun.stdout.includes('Resource posture')) {
      throw new Error(
        `human posture status printed no report (exit ${humanRun.status}): ${
          humanRun.spawnError ||
          humanRun.stdout.slice(0, 400) ||
          humanRun.stderr.slice(0, 400) ||
          'no output'
        }`,
      );
    }
    if (capabilityLines.length === 0) {
      throw new Error(`human output has no line for ${capabilityId}`);
    }
    const wanted = `wants=${rpcCapability.desiredDisposition}`;
    const observed = `observed=${rpcCapability.observedState}`;
    const headline = capabilityLines.find(
      (line) => line.includes(wanted) && line.includes(observed),
    );
    if (!headline) {
      throw new Error(
        `no ${capabilityId} line showed '${wanted}' beside '${observed}': ${proof.humanSample}`,
      );
    }
    if (rpcCapability.observedState === 'running' && headline.includes('observed=stopped')) {
      throw new Error(
        `the ${capabilityId} line claimed an observed stop while the provider is running: ${headline.trim()}`,
      );
    }
    if (!capabilityLines.some((line) => line.includes(`[policy: ${rpcCapability.policySource}]`))) {
      throw new Error(`no ${capabilityId} line carried the winning policy source`);
    }

    // (c) `posture preview` returns the Gateway's plan, and the CLI's exit code
    // agrees with whether the Gateway would reject the requested posture.
    const rpcPreview = rpc('runtime.posture.preview', { runId, posture: 'terminal' });
    const previewRun = cliJson(['resource', 'posture', 'preview', runId, '--posture', 'terminal']);
    proof.preview = {
      exit: previewRun.status,
      posture: previewRun.envelope.data?.posture ?? previewRun.envelope.error?.details?.posture,
      stop: (previewRun.envelope.data?.stop ?? []).map((entry) => entry.capabilityId),
      rejected: Boolean(rpcPreview.rejection),
    };
    const expectedExit = rpcPreview.rejection ? 1 : 0;
    if (previewRun.status !== expectedExit) {
      throw new Error(
        `preview exited ${previewRun.status} while the Gateway ${rpcPreview.rejection ? 'rejected' : 'accepted'} the posture`,
      );
    }
    if (!rpcPreview.rejection) {
      if (previewRun.envelope.data.posture !== 'terminal') {
        throw new Error(`preview resolved ${previewRun.envelope.data.posture}, expected terminal`);
      }
      if (!proof.preview.stop.includes(capabilityId)) {
        throw new Error(`terminal preview did not list ${capabilityId} among the stops`);
      }
    }

    // (d) A gate choice the Gateway refuses must exit non-zero and carry the
    // typed rejection, never be reported as a successful preview.
    const rpcFreeSlot = rpc('runtime.posture.preview', { runId, gateChoice: 'free-slot' });
    const freeSlotRun = cliJson(['resource', 'posture', 'preview', runId, '--choice', 'free-slot']);
    proof.freeSlot = {
      exit: freeSlotRun.status,
      gatewayRejected: Boolean(rpcFreeSlot.rejection),
      errorCode: freeSlotRun.envelope.error?.code ?? null,
      rejectionKind:
        freeSlotRun.envelope.error?.details?.rejection?.kind ??
        freeSlotRun.envelope.data?.rejection?.kind ??
        null,
    };
    if (rpcFreeSlot.rejection) {
      if (freeSlotRun.status !== 1 || freeSlotRun.envelope.status !== 'error') {
        throw new Error('the CLI reported a Gateway-rejected gate choice as a success');
      }
      if (freeSlotRun.envelope.error.code !== 'RESOURCE_POSTURE_REJECTED') {
        throw new Error(`rejection carried code ${freeSlotRun.envelope.error.code}`);
      }
      if (!freeSlotRun.envelope.error.details?.rejection) {
        throw new Error('the error envelope dropped the Gateway rejection');
      }
    } else if (freeSlotRun.status !== 0) {
      throw new Error('the CLI failed a gate choice the Gateway accepted');
    }

    // (e) `project-default` asks the Gateway to defer to the lower precedence
    // levels, so it must never come back as `gate-choice`. Command Center reads
    // this to decide whether the choice was honoured; when it required
    // `gate-choice` for every choice it warned about the one choice that was
    // working as asked.
    const rpcProjectDefault = rpc('runtime.posture.preview', {
      runId,
      gateChoice: 'project-default',
    });
    const projectDefaultRun = cliJson([
      'resource',
      'posture',
      'preview',
      runId,
      '--choice',
      'project-default',
    ]);
    const projectDefaultPlan =
      projectDefaultRun.envelope.data ?? projectDefaultRun.envelope.error?.details;
    proof.projectDefault = {
      exit: projectDefaultRun.status,
      rpcPolicySource: rpcProjectDefault.policySource,
      cliPolicySource: projectDefaultPlan?.policySource ?? null,
      rejected: Boolean(rpcProjectDefault.rejection),
    };
    if (rpcProjectDefault.policySource === 'gate-choice') {
      throw new Error(
        "the Gateway resolved 'project-default' from the gate choice, so deferring is not what it means",
      );
    }
    if (projectDefaultPlan?.policySource !== rpcProjectDefault.policySource) {
      throw new Error(
        `CLI reported policy source ${projectDefaultPlan?.policySource} where the RPC reported ${rpcProjectDefault.policySource}`,
      );
    }

    proof.pass = true;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * Live proof of `resource capability release` (ADR-054 deliverable 9), the
 * round-1 blocker fix, for the case where the lease really is released.
 *
 * The lease is gone and the release action ran, but that result alone cannot
 * prove the provider stopped: another holder of the same capability produces an
 * identical record with the action skipped. So the CLI must report
 * `provider=unknown` and exit 0, and `--stop` must read as a request rather than
 * an outcome. The retained case is `assertCliReleaseRetained` below.
 *
 * `recording` carries this case because it is exclusive, cheap — its acquire is
 * a slot action, not a device boot — and declares neither dependencies nor
 * `keep_warm_ms`, so releasing it runs the real release action.
 */
function assertCliRelease({ slotId, runId }) {
  const proof = { attempted: true, pass: false, error: null, released: null };
  const RELEASE_CAPABILITY = 'recording';
  const acquire = () => {
    const acquired = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: RELEASE_CAPABILITY,
      ownerRunId: runId,
      proofRequirement: {
        capabilityId: RELEASE_CAPABILITY,
        reason: 'release reporting validation',
        mode: 'state',
      },
    });
    if (!acquired.ok) {
      throw new Error(
        `could not acquire ${RELEASE_CAPABILITY} for the release proof: ${acquired.conflict?.reason}`,
      );
    }
  };
  const releaseArgs = [
    'resource',
    'capability',
    'release',
    slotId,
    '--run',
    runId,
    '--capability',
    RELEASE_CAPABILITY,
    '--stop',
  ];
  try {
    // Each release needs its own lease. Reusing one across both calls made the
    // second find nothing to release, so it rendered no capability rows and the
    // assertions about those rows passed without ever reading one.
    acquire();
    const releasedHuman = cliHuman(releaseArgs);
    const releasedLines = releasedHuman.stdout.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
    const releasedRow = releasedLines
      .split('\n')
      .find((line) => line.includes(RELEASE_CAPABILITY) && line.includes('provider='));
    proof.released = {
      humanRow: releasedRow?.trim() ?? null,
      requestLine:
        releasedLines
          .split('\n')
          .find((line) => line.includes('keep-warm requested'))
          ?.trim() ?? null,
    };
    if (!proof.released.requestLine) {
      throw new Error(`the request line was not reported: ${releasedLines.slice(0, 300)}`);
    }
    if (!/keep-warm requested: no/.test(proof.released.requestLine)) {
      throw new Error(`--stop was not reported as the request: ${proof.released.requestLine}`);
    }
    if (!releasedRow) {
      throw new Error(
        `no ${RELEASE_CAPABILITY} row was rendered, so nothing about it was proved: ${releasedLines.slice(0, 300)}`,
      );
    }
    // The claim under review: a released lease is never a proven stop.
    if (!/released {2}provider=unknown/.test(releasedRow)) {
      throw new Error(`a released lease was not reported as unknown: ${releasedRow.trim()}`);
    }
    if (/provider=stopped/.test(releasedLines)) {
      throw new Error(`release claimed an observed stop: ${releasedRow.trim()}`);
    }

    // A second lease for the envelope assertions.
    acquire();
    const releasedRun = cliJson(releaseArgs);
    const releasedResult = releasedRun.envelope.data ?? releasedRun.envelope.error?.details;
    proof.released.exit = releasedRun.status;
    proof.released.envelopeStatus = releasedRun.envelope.status;
    proof.released.released = (releasedResult?.released ?? []).map((lease) => lease.capabilityId);
    proof.released.retained = (releasedResult?.retained ?? []).map((lease) => lease.capabilityId);
    proof.released.failures = releasedResult?.failures ?? [];
    if (releasedRun.status !== 0) {
      throw new Error(
        `releasing ${RELEASE_CAPABILITY} exited ${releasedRun.status}: ${JSON.stringify(proof.released)}`,
      );
    }
    if (!proof.released.released.includes(RELEASE_CAPABILITY)) {
      throw new Error(`the Gateway did not report ${RELEASE_CAPABILITY} released`);
    }
    proof.pass = true;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * The retained half of the release proof.
 *
 * It can only run while the dependency pair is still acquired, which is a
 * window that exists inside the dependency proof and nowhere else: applying
 * `operator-wait` sheds both providers, so afterwards there is no live lease for
 * anything to retain. Releasing the dependency while the dependent still holds
 * it is the one cheap way to observe a retained lease without a second boot.
 */
function assertCliReleaseRetained({ slotId, runId, dependencyPair }) {
  const proof = { attempted: true, pass: false, error: null };
  try {
    {
      const retainedRun = cliJson([
        'resource',
        'capability',
        'release',
        slotId,
        '--run',
        runId,
        '--capability',
        dependencyPair.dependency,
      ]);
      const retainedResult = retainedRun.envelope.data ?? retainedRun.envelope.error?.details;
      proof.retained = {
        attempted: true,
        exit: retainedRun.status,
        errorCode: retainedRun.envelope.error?.code ?? null,
        retained: (retainedResult?.retained ?? []).map((lease) => lease.capabilityId),
        released: (retainedResult?.released ?? []).map((lease) => lease.capabilityId),
      };
      if (!proof.retained.retained.includes(dependencyPair.dependency)) {
        throw new Error(
          `expected ${dependencyPair.dependency} to be retained for ${dependencyPair.dependent}; got ${JSON.stringify(proof.retained)}`,
        );
      }
      if (retainedRun.status !== 1) {
        throw new Error('a retained lease was reported as a successful release');
      }
      if (retainedRun.envelope.error?.code !== 'RUNTIME_CAPABILITY_RELEASE_RETAINED') {
        throw new Error(`retained release carried code ${retainedRun.envelope.error?.code}`);
      }
      const retainedHuman = cliHuman([
        'resource',
        'capability',
        'release',
        slotId,
        '--run',
        runId,
        '--capability',
        dependencyPair.dependency,
      ]);
      const retainedLines = retainedHuman.stdout
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/\r/g, '');
      proof.retained.humanSample = retainedLines
        .split('\n')
        .filter((line) => line.includes(dependencyPair.dependency))
        .join(' | ')
        .trim();
      if (!/retained {2}provider=running/.test(retainedLines)) {
        throw new Error(
          `a retained provider was not reported as running: ${proof.retained.humanSample}`,
        );
      }
    }
    proof.pass = true;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * Live proof that single-capability recovery reaches the Gateway and reports its
 * outcome as-is. After terminal cleanup nothing is warm, so the honest answer is
 * `not-warm` with an observed state the Gateway actually holds.
 */
function assertCliStopWarm({ slotId, capabilityId }) {
  const proof = { attempted: true, pass: false, error: null };
  try {
    const run = cliJson(['resource', 'capability', 'stop-warm', slotId, capabilityId]);
    proof.exit = run.status;
    proof.envelopeStatus = run.envelope.status;
    const result = run.envelope.data ?? run.envelope.error?.details;
    proof.outcome = result?.outcome ?? null;
    proof.observedState = result?.observedState ?? null;
    if (!result) throw new Error(`stop-warm returned no result: ${run.stdout}`);
    if (!['stopped', 'deferred', 'not-warm', 'failed'].includes(result.outcome)) {
      throw new Error(`stop-warm returned an unknown outcome '${result.outcome}'`);
    }
    // The honesty contract: an observed stop is only claimed when the Gateway
    // stopped the provider.
    if (result.observedState === 'stopped' && !['stopped', 'not-warm'].includes(result.outcome)) {
      throw new Error(`stop-warm reported observed 'stopped' with outcome '${result.outcome}'`);
    }
    // Both outcomes that leave the provider running exit non-zero, each with its
    // own code. `not-warm` and `stopped` are successes: nothing was left up.
    const expectedFailure = {
      failed: 'RUNTIME_CAPABILITY_STOP_WARM_FAILED',
      deferred: 'RUNTIME_CAPABILITY_STOP_WARM_DEFERRED',
    }[result.outcome];
    proof.expectedCode = expectedFailure ?? null;
    if (expectedFailure) {
      if (run.status !== 1 || run.envelope.error?.code !== expectedFailure) {
        throw new Error(
          `outcome '${result.outcome}' must exit 1 with ${expectedFailure}; got exit ${run.status} code ${run.envelope.error?.code ?? 'none'}`,
        );
      }
      if (result.outcome === 'deferred' && !result.reason) {
        throw new Error('a deferred stop must name what still needs the provider');
      }
    } else if (run.status !== 0) {
      throw new Error(`stop-warm exited ${run.status} for outcome '${result.outcome}'`);
    }
    proof.pass = true;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * Live proof of family-derived ownership and the terminal family fence.
 *
 * Sibling B is created in A's family BEFORE A's terminal, so a single terminal
 * proves everything. B must stay NON-TERMINAL: a terminal run is a different
 * situation and would make the acquire assertions pass or fail for the wrong
 * reason.
 *
 * Passing `slotId` explicitly makes FIND_SLOT throw "Slot is busy (dispatching)"
 * while A holds the slot, and B fails immediately. So B is created with
 * `allowedSlots` narrowed to A's slot and no `slotId`: with nothing free,
 * FIND_SLOT raises a slot-picker decision and waits, which is non-terminal and
 * claims nothing. The capability RPCs take `slotId` as a parameter and never
 * require B to own the slot.
 *
 * If B still reaches a terminal state, or binds some other slot, the proof is
 * recorded as blocked with a reason. It is never reported as passing.
 */
function prepareFamilyProof({ slotId, project, familyId }) {
  const proof = { attempted: false, pass: false, runId: null, error: null };
  if (!familyId) {
    proof.error = 'first run reported no familyId, so family behaviour cannot be exercised';
    return proof;
  }
  proof.attempted = true;
  const terminalStatuses = ['done', 'failed', 'cancelled'];
  try {
    const created = rpc('run.create', {
      project,
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'resource posture family proof',
      initialContext: 'Family proof sibling. Parks on the slot picker; never dispatches.',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 0 },
      familyId,
      allowedSlots: [slotId],
      skipPrepare: true,
    });
    proof.runId = created.run.id;
    proof.familyId = created.run.familyId ?? null;
    if (created.run.familyId !== familyId) {
      throw new Error(`sibling landed in family ${created.run.familyId}, expected ${familyId}`);
    }

    // Give the engine a moment to reach its waiting state, then require that it
    // is neither terminal nor holding a different slot.
    let sibling = created.run;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      sibling = rpc('run.get', { runId: proof.runId }).run;
      if (terminalStatuses.includes(sibling.status) || sibling.slotId) break;
      sleepMs(500);
    }
    proof.siblingStatusBeforeAcquire = sibling.status;
    proof.siblingSlotId = sibling.slotId ?? null;
    if (terminalStatuses.includes(sibling.status)) {
      throw new Error(
        `blocked: sibling reached terminal status '${sibling.status}' before the acquire assertions, so family derivation could not be proved on a live run`,
      );
    }
    if (sibling.slotId && sibling.slotId !== slotId) {
      throw new Error(
        `blocked: sibling claimed slot ${sibling.slotId} instead of waiting; refusing to acquire against a slot it took`,
      );
    }

    // (a) Acquire with NO ownerFamilyId: the registry must derive it from the
    // run record and stamp it on the lease, or family cleanup would miss it.
    const derived = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: CAPABILITY_ID,
      ownerRunId: proof.runId,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'family derivation validation',
        mode: 'state',
      },
    });
    proof.derivedAcquire = {
      ok: derived.ok,
      familyId: derived.lease?.owner?.familyId ?? null,
      reason: derived.conflict?.reason ?? null,
    };
    if (!derived.ok) throw new Error(`derived-family acquire failed: ${derived.conflict?.reason}`);
    if (derived.lease.owner.familyId !== familyId) {
      throw new Error(
        `lease carries family ${derived.lease.owner.familyId}, expected the run record's ${familyId}`,
      );
    }
    proof.derivedLeaseId = derived.lease.id;

    // (b) A contradicting ownerFamilyId must be refused outright.
    const mismatched = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: CAPABILITY_ID,
      ownerRunId: proof.runId,
      ownerFamilyId: `${familyId}-not-really`,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'family mismatch validation',
        mode: 'state',
      },
    });
    proof.mismatchAcquire = {
      ok: mismatched.ok,
      kind: mismatched.conflict?.kind ?? null,
      reason: mismatched.conflict?.reason ?? null,
    };
    if (mismatched.ok) throw new Error('a contradicting ownerFamilyId was accepted');
    if (mismatched.conflict?.kind !== 'invalid-request') {
      throw new Error(`mismatch refused as ${mismatched.conflict?.kind}, expected invalid-request`);
    }
    const afterMismatch = rpc('runtime.capability.status', {
      slotId,
      ownerRunId: proof.runId,
    }).leases;
    proof.leasesAfterMismatch = afterMismatch.length;
    if (afterMismatch.length !== 1) {
      throw new Error(`a refused acquire created leases: ${afterMismatch.length} present`);
    }
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/** Post-terminal half: family coverage, then the fence. */
function assertFamilyProof({ slotId, proof }) {
  if (!proof.attempted || proof.error) return proof;
  proof.pass = false;
  try {
    // (c) The sibling's lease is covered by the family cleanup A just ran.
    const leases = rpc('runtime.capability.status', {
      slotId,
      ownerRunId: proof.runId,
    }).leases;
    proof.siblingLeasesAfterTerminal = leases.map((lease) => ({
      capabilityId: lease.capabilityId,
      state: lease.state,
    }));
    const held = leases.filter((lease) =>
      ['acquiring', 'acquired', 'releasing'].includes(lease.state),
    );
    if (held.length > 0) {
      throw new Error(
        `family cleanup missed the sibling's lease(s): ${held.map((l) => l.capabilityId).join(', ')}`,
      );
    }

    // (d) And the family is fenced, so the sibling cannot pick it back up.
    const refused = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: CAPABILITY_ID,
      ownerRunId: proof.runId,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'family fence validation',
        mode: 'state',
      },
    });
    proof.fencedAcquire = { ok: refused.ok, reason: refused.conflict?.reason ?? null };
    if (refused.ok) throw new Error('a fenced family member was granted a lease');
    if (!/terminal capability cleanup/.test(refused.conflict?.reason ?? '')) {
      throw new Error(`refused for the wrong reason: ${refused.conflict?.reason}`);
    }
    proof.pass = true;
  } catch (error) {
    proof.pass = false;
    proof.error = error?.message || String(error);
  }
  return proof;
}

/**
 * (e) Cleanup. The sibling reaches a terminal state on its own (FIND_SLOT
 * refuses a busy slot), so an already-terminal run is a successful cleanup, not
 * a failure; only a live run is cancelled.
 */
function cleanupFamilyProof({ slotId, proof }) {
  if (!proof.runId) return proof;
  try {
    const before = rpc('run.get', { runId: proof.runId }).run;
    proof.siblingFinalStatus = before?.status ?? null;
    const terminal = ['done', 'failed', 'cancelled'];
    if (before && !terminal.includes(before.status)) {
      rpc(
        'run.cancel',
        { runId: proof.runId, reason: `${SCENARIO_ID} family proof complete` },
        SLOW_RPC_TIMEOUT_MS,
      );
      proof.siblingFinalStatus = rpc('run.get', { runId: proof.runId }).run?.status ?? null;
    }
    const leases = rpc('runtime.capability.status', { slotId, ownerRunId: proof.runId }).leases;
    proof.leftoverLeases = leases
      .filter((lease) => ['acquiring', 'acquired', 'releasing'].includes(lease.state))
      .map((lease) => lease.capabilityId);
    if (proof.leftoverLeases.length > 0) {
      proof.pass = false;
      proof.error = proof.error ?? `sibling left leases: ${proof.leftoverLeases.join(', ')}`;
    }
  } catch (cleanupError) {
    proof.pass = false;
    proof.error = proof.error ?? `sibling cleanup failed: ${cleanupError?.message}`;
  }
  return proof;
}

export async function runScenario({ timeoutMs, outDir, slotId, explicit = false }) {
  const reportRunner = 'scripted';
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const requirement =
      'resource-posture-smoke needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches a real scripted validation run';
    const report = explicit
      ? { runner: reportRunner, pass: false, error: requirement }
      : { runner: reportRunner, skipped: true, skipReason: requirement, pass: true };
    const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
    return {
      scenario: SCENARIO_ID,
      runner: reportRunner,
      outPath,
      pass: report.pass,
      ...(explicit ? {} : { skipped: true }),
      report,
    };
  }

  const report = {
    runner: reportRunner,
    slotId,
    capabilityId: CAPABILITY_ID,
    runId: null,
    project: null,
    acquire: null,
    waitPreview: null,
    waitApply: null,
    waitStatus: null,
    terminalApply: null,
    terminalStatus: null,
    persistedPosture: null,
    dependencyProof: null,
    familyProof: null,
    cliProof: null,
    cliReleaseProof: null,
    cliStopWarmProof: null,
    leftoverLeases: null,
    pass: false,
    error: null,
  };
  let runId = null;

  try {
    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;
    if (slot.project !== 'farmslot-farm') {
      throw new Error(`slot ${slotId} runs project ${slot.project}; expected farmslot-farm`);
    }

    const created = rpc('run.create', {
      project: slot.project,
      flowType: 'dev',
      // Free-text tickets are accepted only by flexible interactive starts;
      // the scripted runner still makes no changes.
      mode: 'interactive',
      ticketOrPr: 'resource posture validation',
      initialContext: 'Resource posture validation run. Makes no changes.',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 2000 },
      slotId,
      skipPrepare: true,
    });
    runId = created.run.id;
    report.runId = runId;
    report.familyId = created.run.familyId ?? null;

    await poll(
      'the run to bind its slot',
      () => rpc('run.get', { runId }).run,
      (state) => state.slotId === slotId,
      timeoutMs,
    );

    // The worker path: the same acquire RPC a worker calls from its proof plan.
    const acquired = rpc('runtime.capability.acquire', {
      slotId,
      capabilityId: CAPABILITY_ID,
      ownerRunId: runId,
      proofRequirement: {
        capabilityId: CAPABILITY_ID,
        reason: 'resource posture live validation',
        mode: 'state',
      },
    });
    report.acquire = { ok: acquired.ok, leaseState: acquired.lease?.state ?? null };
    if (!acquired.ok) {
      throw new Error(`capability acquire failed: ${acquired.conflict?.reason ?? 'unknown'}`);
    }

    // Preview must describe the exact effect before anything is applied.
    const waitPreview = rpc('runtime.posture.preview', { runId, posture: 'operator-wait' });
    report.waitPreview = {
      posture: waitPreview.posture,
      policySource: waitPreview.policySource,
      retain: waitPreview.retain.map((state) => state.capabilityId),
      warm: waitPreview.warm.map((state) => state.capabilityId),
      stop: waitPreview.stop.map((state) => state.capabilityId),
      effects: waitPreview.effects,
    };
    if (waitPreview.posture !== 'operator-wait') {
      throw new Error(`preview resolved posture ${waitPreview.posture}, expected operator-wait`);
    }

    const waitApply = rpc('runtime.posture.apply', {
      runId,
      posture: 'operator-wait',
      operationId: `${SCENARIO_ID}-wait-${process.pid}`,
    });
    report.waitApply = {
      ok: waitApply.ok,
      outcome: waitApply.transition.outcome,
      policySource: waitApply.transition.policySource,
    };
    if (!waitApply.ok) {
      throw new Error(`operator-wait apply failed: ${JSON.stringify(waitApply.transition)}`);
    }

    const waitStatus = rpc('runtime.posture.status', { runId });
    const waitState = capabilityState(waitStatus, CAPABILITY_ID);
    report.waitStatus = waitState;
    if (!waitState) throw new Error(`posture status reported no state for ${CAPABILITY_ID}`);
    // A medium-cost provider stays usable for the next operator action.
    if (waitState.desiredDisposition !== 'acquired') {
      throw new Error(
        `expected ${CAPABILITY_ID} desired 'acquired' at operator-wait, got '${waitState.desiredDisposition}'`,
      );
    }
    if (waitState.observedState !== 'running') {
      throw new Error(`expected observed 'running', got '${waitState.observedState}'`);
    }
    if (waitStatus.state.workerRetained !== true) {
      throw new Error('operator-wait must never report the worker as stopped');
    }

    // ADR-054 deliverable 9: the typed CLI surface, proved against this live
    // posture rather than a fixture.
    report.cliProof = assertCliPostureSurface({ runId, capabilityId: CAPABILITY_ID });
    if (!report.cliProof.pass) {
      throw new Error(`CLI posture proof failed: ${report.cliProof.error}`);
    }

    // ADR-054 dependency ordering, proved live against the project's own catalog.
    // This runs BEFORE the base terminal step on purpose: terminal cleanup fences
    // the run, and a fenced run is then correctly refused any further acquire.
    // ADR-054 dependency ordering, proved live against the project's own catalog.
    report.dependencyProof = await prepareDependencyPosture({
      slotId,
      runId,
      report,
      // Respect the operator's --timeout-ms while allowing a real device boot.
      acquireBudgetMs: Math.max(timeoutMs, SLOW_RPC_TIMEOUT_MS),
    });
    if (report.dependencyProof.error) {
      throw new Error(`dependency posture proof failed: ${report.dependencyProof.error}`);
    }

    // `resource capability release`, the round-1 blocker fix, proved live.
    report.cliReleaseProof = assertCliRelease({ slotId, runId });
    if (!report.cliReleaseProof.pass) {
      throw new Error(`CLI release proof failed: ${report.cliReleaseProof.error}`);
    }

    // ADR-054 family ownership, proved live: the sibling is created before the
    // terminal so one teardown proves derivation, coverage, and the fence.
    report.familyProof = prepareFamilyProof({
      slotId,
      project: report.project,
      familyId: report.familyId,
    });
    if (report.familyProof.error) {
      throw new Error(`family proof setup failed: ${report.familyProof.error}`);
    }

    const terminalApply = rpc('runtime.posture.apply', {
      runId,
      posture: 'terminal',
      operationId: `${SCENARIO_ID}-terminal-${process.pid}`,
    });
    report.terminalApply = {
      ok: terminalApply.ok,
      outcome: terminalApply.transition.outcome,
      effects: terminalApply.transition.effects,
      failures: terminalApply.transition.failures,
    };
    if (!terminalApply.ok) {
      throw new Error(`terminal apply failed: ${JSON.stringify(terminalApply.transition)}`);
    }

    const terminalStatus = rpc('runtime.posture.status', { runId });
    const terminalState = capabilityState(terminalStatus, CAPABILITY_ID);
    report.terminalStatus = terminalState;
    if (terminalState?.desiredDisposition !== 'stopped') {
      throw new Error(
        `expected ${CAPABILITY_ID} desired 'stopped' at terminal, got '${terminalState?.desiredDisposition}'`,
      );
    }
    if (terminalState.observedState !== 'stopped') {
      throw new Error(
        `expected observed 'stopped' at terminal, got '${terminalState.observedState}'`,
      );
    }

    // Single-capability recovery through the CLI. After terminal cleanup nothing
    // is warm, so the Gateway's honest answer is `not-warm`.
    report.cliStopWarmProof = assertCliStopWarm({ slotId, capabilityId: CAPABILITY_ID });
    if (!report.cliStopWarmProof.pass) {
      throw new Error(`CLI stop-warm proof failed: ${report.cliStopWarmProof.error}`);
    }

    // The same teardown proves the dependency pair: dependent before dependency,
    // both stopped.
    report.dependencyProof = assertDependencyTerminal({
      slotId,
      runId,
      proof: report.dependencyProof,
    });
    // Pass only on a real proof or an explicit opt-out. An unattempted,
    // unskipped proof is a failure.
    if (!report.dependencyProof.pass && !report.dependencyProof.skipped) {
      throw new Error(
        `dependency posture proof failed: ${report.dependencyProof.error ?? report.dependencyProof.reason ?? 'not attempted'}`,
      );
    }

    report.familyProof = assertFamilyProof({ slotId, proof: report.familyProof });
    if (report.familyProof.attempted && !report.familyProof.pass) {
      throw new Error(`family proof failed: ${report.familyProof.error}`);
    }

    // Repeating the same posture must be idempotent, not a second stop.
    const repeat = rpc('runtime.posture.apply', { runId, posture: 'terminal' });
    report.terminalRepeatOutcome = repeat.transition.outcome;
    if (repeat.transition.outcome !== 'idempotent') {
      throw new Error(
        `repeat terminal reported '${repeat.transition.outcome}', expected idempotent`,
      );
    }

    // The posture is durable on the run, so a reconnecting client sees it.
    const persisted = rpc('run.get', { runId }).run.resourcePosture ?? null;
    report.persistedPosture = persisted
      ? {
          posture: persisted.posture,
          policySource: persisted.policySource,
          lastTransition: persisted.lastTransition?.outcome ?? null,
        }
      : null;
    if (persisted?.posture !== 'terminal') {
      throw new Error(
        `run record did not persist the terminal posture: ${JSON.stringify(persisted)}`,
      );
    }

    report.pass = true;
  } catch (error) {
    report.error = error?.message || String(error);
  } finally {
    if (report.familyProof?.runId) {
      report.familyProof = cleanupFamilyProof({ slotId, proof: report.familyProof });
      if (report.familyProof.attempted && !report.familyProof.pass) {
        report.pass = false;
        report.error = report.error ?? `family proof failed: ${report.familyProof.error}`;
      }
    }
    if (runId) {
      try {
        const cancelResult = rpc(
          'run.cancel',
          { runId, reason: `${SCENARIO_ID} validation complete` },
          SLOW_RPC_TIMEOUT_MS,
        );
        const failedEffects = (cancelResult?.effects ?? []).filter(
          (effect) => effect.status === 'failed',
        );
        report.cancelEffects = (cancelResult?.effects ?? []).map((effect) => ({
          name: effect.name,
          status: effect.status,
        }));
        const after = rpc('run.get', { runId }).run;
        report.finalStatus = after?.status ?? null;
        const releaseDeadline = Date.now() + 10_000;
        let slotOwner = null;
        for (;;) {
          slotOwner = rpc('fleet.status').fleet?.slots?.find(
            (candidate) => candidate.slot === slotId,
          )?.currentRunId;
          if (slotOwner !== runId || Date.now() >= releaseDeadline) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        report.slotReleased = slotOwner !== runId;

        // Cancel routes through the ADR-054 terminal reconcile, so nothing this
        // run acquired may still be held. This is the durable answer to "did a
        // timed-out acquire leak a provider".
        try {
          const leases = rpc('runtime.capability.status', { slotId, ownerRunId: runId }).leases;
          report.leftoverLeases = leases
            .filter((lease) => ['acquiring', 'acquired', 'releasing'].includes(lease.state))
            .map((lease) => ({
              capabilityId: lease.capabilityId,
              state: lease.state,
              cleanupFailure: lease.cleanupFailure ?? null,
            }));
        } catch (leaseError) {
          report.leftoverLeasesError = leaseError?.message || String(leaseError);
          report.leftoverLeases = null;
        }
        if (report.leftoverLeases === null || report.leftoverLeases.length > 0) {
          report.pass = false;
          report.error =
            report.error ??
            (report.leftoverLeases === null
              ? `could not verify leftover leases: ${report.leftoverLeasesError}`
              : `run still holds ${report.leftoverLeases.length} lease(s) after cancel: ` +
                report.leftoverLeases.map((lease) => lease.capabilityId).join(', '));
        }

        report.cancelled =
          after?.status === 'cancelled' && failedEffects.length === 0 && report.slotReleased;
        if (!report.cancelled) {
          report.pass = false;
          report.leakedRunId = runId;
          report.cancelError =
            failedEffects.length > 0
              ? `run.cancel reported failed effect(s): ${failedEffects.map((effect) => effect.name).join(', ')}`
              : !report.slotReleased
                ? `slot ${slotId} still reports currentRunId ${runId} after cancel`
                : `run ${runId} is ${report.finalStatus ?? 'unreadable'} after cancel, expected cancelled`;
          report.error = report.error ?? report.cancelError;
        }
      } catch (cancelError) {
        report.pass = false;
        report.cancelled = false;
        report.leakedRunId = runId;
        report.cancelError = cancelError?.message || String(cancelError);
        report.error = report.error ?? report.cancelError;
      }
    }
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
