/**
 * `farmslot resource posture` and `farmslot resource capability` (ADR-054,
 * deliverable 9).
 *
 * Every line printed here comes from a Gateway RPC result. The CLI resolves no
 * policy of its own: it never decides what should be retained, warm, or stopped,
 * and it never claims a provider stopped unless the Gateway observed it stopped.
 * The desired/observed comparison and the observed-state counts come from the
 * shared protocol derivations, so this output cannot drift from Command Center
 * or Companion.
 */
import { Command, Option } from 'commander';

import {
  RESOURCE_POSTURE_GATE_CHOICES,
  RESOURCE_POSTURES,
  type ResourcePosture,
  type ResourcePostureCapabilityState,
  resourcePostureCounts,
  type ResourcePostureGateChoice,
  type ResourcePostureObservedState,
  type ResourcePosturePlan,
  type ResourcePostureRejection,
  type ResourcePostureRowStatus,
  resourcePostureRowStatus,
  type ResourcePostureTransition,
  resourcePostureTransitionFailuresToShow,
  type RunResourcePostureState,
  RUNTIME_CAPABILITY_PROOF_MODES,
  type RuntimeCapabilityAcquireParams,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityLease,
  RuntimeCapabilityMethods,
  type RuntimeCapabilityProofMode,
  type RuntimeCapabilityReleaseParams,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStopWarmParams,
  type RuntimeCapabilityStopWarmResult,
  type RuntimePostureApplyParams,
  type RuntimePostureApplyResult,
  RuntimePostureMethods,
  type RuntimePosturePreviewParams,
  type RuntimePosturePreviewResult,
  type RuntimePostureStatusResult,
} from '@farmslot/protocol';

import { bold, dim, green, red, yellow } from '../colors.js';
import { resolveContext } from '../context.js';
import { createEmitter, type EnvelopeEmitter } from '../envelope.js';
import type { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

interface PostureTargetOptions {
  posture?: ResourcePosture;
  choice?: ResourcePostureGateChoice;
}

interface PostureApplyOptions extends PostureTargetOptions {
  operationId?: string;
}

interface CapabilityAcquireOptions {
  run: string;
  reason: string;
  mode: RuntimeCapabilityProofMode;
  revalidateHealth?: boolean;
}

interface CapabilityReleaseOptions {
  run: string;
  capability?: string;
  lease?: string;
  force?: boolean;
  stop?: boolean;
}

/**
 * Terse markers for the shared desired-versus-observed comparison. `unobserved`
 * is its own word on purpose: the Gateway could not see the provider, so
 * neither "match" nor "mismatch" would be true.
 */
function rowStatusMarker(rowStatus: ResourcePostureRowStatus): string {
  if (rowStatus === 'matches') return green('match');
  if (rowStatus === 'mismatch') return red('mismatch');
  if (rowStatus === 'pending') return yellow('pending');
  return dim('unobserved');
}

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : dim('none');
}

export function rejectionLine(rejection: ResourcePostureRejection): string {
  if (rejection.kind === 'park-ineligible') {
    return red(`Rejected: the run cannot be parked (${rejection.code}) — ${rejection.reason}`);
  }
  if (rejection.kind === 'capability-unavailable') {
    return red(
      `Rejected: ${rejection.capabilityId} is unavailable (${rejection.conflict.kind}) — ${rejection.reason}`,
    );
  }
  return red(`Rejected: ${rejection.reason}`);
}

/**
 * One capability, two lines: what the Gateway wanted next to what it saw, then
 * the reason and the precedence level that produced it.
 */
export function capabilityLines(state: ResourcePostureCapabilityState): string[] {
  const rowStatus = resourcePostureRowStatus(state.desiredDisposition, state.observedState);
  const lines = [
    `  ${bold(state.capabilityId)}  wants=${state.desiredDisposition}  observed=${state.observedState}  ${rowStatusMarker(rowStatus)}${
      state.warmUntil ? `  warm-until=${state.warmUntil}` : ''
    }`,
    dim(`    ${state.reason}  [policy: ${state.policySource}]`),
  ];
  if (state.cleanupFailure) {
    lines.push(red(`    cleanup failed: ${state.cleanupFailure}`));
  }
  return lines;
}

function transitionLines(transition: ResourcePostureTransition): string[] {
  const lines = [
    `${bold('Last transition')}  posture=${transition.posture}  outcome=${transition.outcome}  policy=${transition.policySource}${
      transition.gateChoice ? `  choice=${transition.gateChoice}` : ''
    }  steps=${transition.progress.completed}/${transition.progress.total}  at=${
      transition.completedAt ?? transition.requestedAt
    }  id=${transition.id}`,
  ];
  if (transition.effects.length > 0) {
    lines.push(dim(`  effects: ${transition.effects.join('; ')}`));
  }
  if (transition.rejection) lines.push(`  ${rejectionLine(transition.rejection)}`);
  return lines;
}

export function formatPostureState(
  runId: string,
  /** `undefined` when the result does not carry a slot; `null` when it has none. */
  slotId: string | null | undefined,
  state: RunResourcePostureState,
): string {
  const counts = resourcePostureCounts(state.capabilities, state.lastTransition);
  const lines = [
    `${bold('Resource posture')}  run=${runId}${slotId === undefined ? '' : `  slot=${slotId ?? 'none'}`}`,
    `posture=${state.posture}  policy=${state.policySource}${
      state.gateChoice ? `  choice=${state.gateChoice}` : ''
    }${state.waitPolicy ? `  dispatch-preset=${state.waitPolicy}` : ''}  worker=${
      state.workerRetained ? 'retained' : 'stopped'
    }  updated=${state.updatedAt}`,
    // Observed counts, never desired ones: a provider the Gateway meant to stop
    // but could not is reported as failed or unresolved, never as stopped.
    `observed  ${counts.retained} retained · ${counts.warm} warm · ${counts.stopped} stopped · ${counts.failed} failed · ${counts.unresolved} unresolved`,
  ];
  if (state.lastTransition) lines.push('', ...transitionLines(state.lastTransition));
  // Failures the Gateway reported for the transition that no capability entry
  // already carries; without this they would be reported nowhere.
  for (const failure of resourcePostureTransitionFailuresToShow(
    state.capabilities,
    state.lastTransition,
  )) {
    lines.push(red(`  transition failure on ${failure.capabilityId}: ${failure.reason}`));
  }
  lines.push('');
  if (state.capabilities.length === 0) {
    lines.push(dim('  This run holds no runtime capabilities.'));
  } else {
    for (const capability of state.capabilities) lines.push(...capabilityLines(capability));
  }
  return lines.join('\n').trimEnd();
}

export function formatPostureStatus(result: RuntimePostureStatusResult): string {
  return formatPostureState(result.runId, result.slotId, result.state);
}

function planGroup(label: string, states: ResourcePostureCapabilityState[]): string[] {
  if (states.length === 0) return [`${label.padEnd(7)} ${dim('none')}`];
  return [
    `${label.padEnd(7)} ${states.map((state) => state.capabilityId).join(', ')}`,
    ...states.flatMap(capabilityLines),
  ];
}

export function formatPosturePlan(plan: ResourcePosturePlan): string {
  const lines = [
    `${bold('Posture preview')}  run=${plan.runId}  slot=${plan.slotId ?? 'none'}`,
    `posture=${plan.posture}  policy=${plan.policySource}`,
    dim(plan.reason),
    '',
    ...planGroup('acquire', plan.acquire),
    ...planGroup('retain', plan.retain),
    ...planGroup('warm', plan.warm),
    ...planGroup('stop', plan.stop),
    '',
    `effects: ${list(plan.effects)}`,
  ];
  if (plan.rejection) lines.push('', rejectionLine(plan.rejection));
  return lines.join('\n').trimEnd();
}

export function formatPostureApply(runId: string, result: RuntimePostureApplyResult): string {
  const lines = [
    `${bold('Posture apply')}  run=${runId}  ok=${result.ok ? 'yes' : 'no'}`,
    ...transitionLines(result.transition),
  ];
  for (const failure of result.transition.failures) {
    lines.push(red(`  failure on ${failure.capabilityId}: ${failure.reason}`));
  }
  // The apply result carries no slot, so the status block omits it rather than
  // printing a placeholder that reads like "this run has no slot".
  return [...lines, '', formatPostureState(runId, undefined, result.status)].join('\n').trimEnd();
}

export function formatStopWarm(result: RuntimeCapabilityStopWarmResult): string {
  const lines = [
    `${bold('Stop warm provider')}  slot=${result.slotId}  capability=${result.capabilityId}`,
    // `outcome` and `observedState` are the Gateway's words. `stopped` here means
    // the Gateway watched it stop, not that a release RPC returned.
    `outcome=${result.outcome}  observed=${result.observedState}`,
  ];
  if (result.reason) lines.push(dim(`  ${result.reason}`));
  if (result.cleanupFailure) lines.push(red(`  cleanup failed: ${result.cleanupFailure}`));
  lines.push(`effects: ${list(result.effects)}`);
  return lines.join('\n');
}

/**
 * Outcomes that leave the provider running. `deferred` is one of them: the
 * Gateway declined to stop the provider because something still needs it, so
 * exiting zero would tell a script the provider is down when it is not.
 * `not-warm` is the only non-stop outcome that is a success — there was nothing
 * warm to stop.
 */
export function stopWarmIncomplete(result: RuntimeCapabilityStopWarmResult): boolean {
  return result.outcome === 'failed' || result.outcome === 'deferred';
}

export function stopWarmError(result: RuntimeCapabilityStopWarmResult): Error {
  const failed = result.outcome === 'failed';
  return Object.assign(
    new Error(
      failed
        ? `Cleanup failed; ${result.capabilityId} is observed '${result.observedState}'.`
        : `Stop deferred; ${result.capabilityId} is observed '${result.observedState}'${
            result.reason ? ` — ${result.reason}` : ''
          }.`,
    ),
    {
      code: failed
        ? 'RUNTIME_CAPABILITY_STOP_WARM_FAILED'
        : 'RUNTIME_CAPABILITY_STOP_WARM_DEFERRED',
      userAction: failed
        ? `Re-read the provider state with \`farmslot rpc runtime.capability.status '{"slotId":"${result.slotId}"}'\` and fix the provider's release action before retrying.`
        : `Release or stop whatever still holds ${result.capabilityId} on ${result.slotId}, then stop it again. \`farmslot resource posture status <runId>\` names the run that holds it.`,
      details: result,
    },
  );
}

function leaseLine(lease: RuntimeCapabilityLease): string {
  return `  ${bold(lease.capabilityId)}  lease=${lease.id}  state=${lease.state}  health=${lease.health.state}${
    lease.keepWarmUntil ? `  warm-until=${lease.keepWarmUntil}` : ''
  }${lease.cleanupFailure ? `  ${red(`cleanup failed: ${lease.cleanupFailure}`)}` : ''}`;
}

export function formatCapabilityAcquire(
  result: RuntimeCapabilityAcquireResult,
  params: RuntimeCapabilityAcquireParams,
): string {
  const header = `${bold('Acquire capability')}  slot=${params.slotId}  capability=${params.capabilityId}  run=${params.ownerRunId}`;
  if (!result.ok) {
    return [header, red(`refused (${result.conflict.kind}): ${result.conflict.reason}`)].join('\n');
  }
  const lines = [header, result.idempotent ? 'already held' : 'acquired', leaseLine(result.lease)];
  if (result.dependencyLeases.length > 0) {
    lines.push('dependencies:', ...result.dependencyLeases.map(leaseLine));
  }
  return lines.join('\n');
}

/** What the Gateway did with one lease. Distinct from what the operator asked for. */
export const CAPABILITY_RELEASE_OUTCOMES = [
  /** Released, and the provider is deliberately kept alive to a deadline. */
  'warm',
  /** Released, but this result alone does not prove the provider stopped. */
  'released',
  /** Not released: something else still needs the provider. */
  'retained',
  /** The release action ran and failed, so the provider's real state is unknown. */
  'cleanup-failed',
] as const;
export type CapabilityReleaseOutcome = (typeof CAPABILITY_RELEASE_OUTCOMES)[number];

export interface CapabilityReleaseRow {
  capabilityId: string;
  leaseId: string;
  outcome: CapabilityReleaseOutcome;
  /** Strictly what the result proves about the provider — never more than that. */
  observed: ResourcePostureObservedState;
  detail: string;
  warmUntil?: string;
}

/**
 * Per-lease outcome of a release, derived only from the Gateway's own result.
 *
 * `stopped` is deliberately unreachable here. A released lease with no warm
 * deadline looks identical whether the release action ran and stopped the
 * provider or whether another lease on the same capability kept it up, in which
 * case the action never ran at all. The release result cannot tell those apart,
 * so the honest answer is `unknown` and a pointer at the command that can.
 */
export function capabilityReleaseRows(
  result: RuntimeCapabilityReleaseResult,
  nowMs: number,
): CapabilityReleaseRow[] {
  const failureByLease = new Map(result.failures.map((failure) => [failure.leaseId, failure]));
  const rows: CapabilityReleaseRow[] = result.failures.map((failure) => ({
    capabilityId: failure.capabilityId,
    leaseId: failure.leaseId,
    outcome: 'cleanup-failed',
    observed: 'unknown',
    detail: failure.reason,
  }));
  for (const lease of result.retained) {
    rows.push({
      capabilityId: lease.capabilityId,
      leaseId: lease.id,
      outcome: 'retained',
      // Retained means the Gateway kept it up on purpose, so it is running.
      observed: 'running',
      detail: 'something that still holds it needs this provider',
    });
  }
  for (const lease of result.released) {
    if (failureByLease.has(lease.id)) continue;
    const warmUntil = lease.keepWarmUntil;
    if (warmUntil && Date.parse(warmUntil) > nowMs) {
      rows.push({
        capabilityId: lease.capabilityId,
        leaseId: lease.id,
        outcome: 'warm',
        observed: 'running',
        detail: 'lease released; the provider is kept alive to its warm deadline',
        warmUntil,
      });
      continue;
    }
    rows.push({
      capabilityId: lease.capabilityId,
      leaseId: lease.id,
      outcome: 'released',
      observed: 'unknown',
      detail: 'lease released; this result does not prove the provider stopped',
    });
  }
  return rows;
}

export function formatCapabilityRelease(
  result: RuntimeCapabilityReleaseResult,
  params: RuntimeCapabilityReleaseParams,
  nowMs = Date.now(),
): string {
  const rows = capabilityReleaseRows(result, nowMs);
  const lines = [
    `${bold('Release capability')}  slot=${params.slotId}  run=${params.ownerRunId}${
      params.capabilityId ? `  capability=${params.capabilityId}` : ''
    }${params.leaseId ? `  lease=${params.leaseId}` : ''}`,
    // The request is what the operator asked for. It is reported on its own line
    // because it says nothing about what happened.
    // The request names the flag that was sent and nothing else. It cannot
    // describe an outcome: the Gateway skips the release action entirely when
    // another holder still needs the provider, and that case reports no failure
    // at all, so `--stop` and "the provider stopped" are unrelated facts.
    `keep-warm requested: ${params.keepWarm === false ? 'no' : 'yes'}${
      params.force ? '  force: yes' : ''
    }`,
  ];
  if (rows.length === 0) {
    lines.push(dim('no lease matched this request'));
  }
  for (const row of rows) {
    const marker =
      row.outcome === 'cleanup-failed' ? red : row.observed === 'running' ? yellow : dim;
    lines.push(
      `  ${bold(row.capabilityId)}  lease=${row.leaseId}  ${marker(row.outcome)}  provider=${row.observed}${
        row.warmUntil ? `  warm-until=${row.warmUntil}` : ''
      }`,
      dim(`    ${row.detail}`),
    );
  }
  lines.push(`effects: ${list(result.effects)}`);
  // Nothing above claims a stop, so name the command that can actually prove one.
  if (rows.some((row) => row.outcome === 'released')) {
    lines.push(
      dim(
        'To confirm a provider really stopped, read `farmslot resource posture status <runId>`, or stop a warm one with `farmslot resource capability stop-warm <slotId> <capabilityId>`.',
      ),
    );
  }
  return lines.join('\n');
}

/**
 * Whether a release left the operator's request unfulfilled.
 *
 * A cleanup failure is the obvious case. A retained lease is the same class as
 * a deferred `stop-warm`: the Gateway declined to release it because something
 * still needs the provider, so the lease the operator asked to drop is still
 * held and the provider is still up. Exiting zero there tells a script the
 * request took effect when nothing changed.
 */
export function capabilityReleaseIncomplete(result: RuntimeCapabilityReleaseResult): boolean {
  return result.failures.length > 0 || result.retained.length > 0;
}

export function capabilityReleaseError(
  result: RuntimeCapabilityReleaseResult,
  ownerRunId: string,
): Error {
  const failed = result.failures.length > 0;
  const retainedIds = [...new Set(result.retained.map((lease) => lease.capabilityId))];
  return Object.assign(
    new Error(
      failed
        ? `Cleanup failed for ${result.failures.length} lease(s).`
        : `Retained ${result.retained.length} lease(s) that something else still needs: ${retainedIds.join(', ')}.`,
    ),
    {
      code: failed ? 'RUNTIME_CAPABILITY_RELEASE_FAILED' : 'RUNTIME_CAPABILITY_RELEASE_RETAINED',
      userAction: failed
        ? `Read the provider's observed state with \`farmslot resource posture status ${ownerRunId}\` before assuming anything stopped.`
        : `Release whatever still depends on ${retainedIds.join(', ')} first; \`farmslot resource posture status ${ownerRunId}\` names what is holding it.`,
      details: result,
    },
  );
}

/** Outcomes that mean the operator's request did not take effect. */
export function postureApplyFailed(result: RuntimePostureApplyResult): boolean {
  return (
    !result.ok ||
    result.transition.outcome === 'rejected' ||
    result.transition.outcome === 'failed' ||
    result.transition.outcome === 'partial'
  );
}

function postureTargetParams(
  runId: string,
  options: PostureTargetOptions,
): RuntimePosturePreviewParams {
  return {
    runId,
    ...(options.posture ? { posture: options.posture } : {}),
    ...(options.choice ? { gateChoice: options.choice } : {}),
  };
}

function postureOption(): Option {
  return new Option(
    '--posture <posture>',
    'Semantic lifecycle posture; omit to use the persisted posture of the run',
  ).choices([...RESOURCE_POSTURES]);
}

function choiceOption(): Option {
  return new Option(
    '--choice <choice>',
    'Operator gate choice; wins over --posture at an operator wait',
  ).choices([...RESOURCE_POSTURE_GATE_CHOICES]);
}

function emit(
  output: OutputContext,
  emitter: EnvelopeEmitter,
  result: unknown,
  render: () => string,
): void {
  if (emitter.machine) emitter.ok(result);
  else output.write(`${render()}\n`);
}

export function registerResourcePostureCommands(resource: Command): void {
  const posture = resource
    .command('posture')
    .description('Inspect, preview, and apply the resource posture of a run (ADR-054)');

  posture
    .command('status')
    .description('Show the posture, desired disposition, and observed provider state of a run')
    .argument('<runId>', 'Run identifier')
    .action(async (runId: string, _options: unknown, command: Command) => {
      const { client, output } = resolveContext(command);
      const emitter = createEmitter(output, command);
      try {
        const result = await withProgress(
          `Loading posture for ${runId}`,
          () => client.call<RuntimePostureStatusResult>(RuntimePostureMethods.status, { runId }),
          !emitter.machine,
        );
        emit(output, emitter, result, () => formatPostureStatus(result));
      } catch (error) {
        emitter.fail(error);
      }
    });

  posture
    .command('preview')
    .description('Show exactly what applying a posture would acquire, retain, warm, or stop')
    .argument('<runId>', 'Run identifier')
    .addOption(postureOption())
    .addOption(choiceOption())
    .action(async (runId: string, options: PostureTargetOptions, command: Command) => {
      const { client, output } = resolveContext(command);
      const emitter = createEmitter(output, command);
      const params = postureTargetParams(runId, options);
      try {
        const plan = await withProgress(
          `Previewing posture for ${runId}`,
          () => client.call<RuntimePosturePreviewResult>(RuntimePostureMethods.preview, params),
          !emitter.machine,
        );
        if (plan.rejection) {
          // A previewed rejection is not a successful preview of a change: the
          // posture cannot be applied, so scripts must see a non-zero exit.
          if (!emitter.machine) output.write(`${formatPosturePlan(plan)}\n`);
          emitter.fail(
            Object.assign(new Error('The Gateway would reject this posture; nothing changed.'), {
              code: 'RESOURCE_POSTURE_REJECTED',
              userAction:
                'Pick a posture or gate choice the Gateway accepts, or clear the reported blocker, then preview again.',
              details: plan,
            }),
          );
          return;
        }
        emit(output, emitter, plan, () => formatPosturePlan(plan));
      } catch (error) {
        emitter.fail(error);
      }
    });

  posture
    .command('apply')
    .description('Apply a posture and report the transition outcome the Gateway observed')
    .argument('<runId>', 'Run identifier')
    .addOption(postureOption())
    .addOption(choiceOption())
    .option('--operation-id <id>', 'Idempotency key; replaying it returns the stored transition')
    .action(async (runId: string, options: PostureApplyOptions, command: Command) => {
      const { client, output } = resolveContext(command);
      const emitter = createEmitter(output, command);
      const params: RuntimePostureApplyParams = {
        ...postureTargetParams(runId, options),
        ...(options.operationId ? { operationId: options.operationId } : {}),
      };
      try {
        const result = await withProgress(
          `Applying posture to ${runId}`,
          () => client.call<RuntimePostureApplyResult>(RuntimePostureMethods.apply, params),
          !emitter.machine,
        );
        if (postureApplyFailed(result)) {
          if (!emitter.machine) output.write(`${formatPostureApply(runId, result)}\n`);
          emitter.fail(
            Object.assign(new Error(`Posture transition ended '${result.transition.outcome}'.`), {
              code: 'RESOURCE_POSTURE_TRANSITION_INCOMPLETE',
              userAction: `Read the per-capability desired and observed state with \`farmslot resource posture status ${runId}\`, then recover one provider with \`farmslot resource capability stop-warm\` or \`... capability acquire\`.`,
              details: result,
            }),
          );
          return;
        }
        emit(output, emitter, result, () => formatPostureApply(runId, result));
      } catch (error) {
        emitter.fail(error);
      }
    });

  const capability = resource
    .command('capability')
    .description('Single-capability recovery on one slot (ADR-054)');

  capability
    .command('stop-warm')
    .description('Stop a provider that a released lease is keeping warm')
    .argument('<slotId>', 'Slot identifier')
    .argument('<capabilityId>', 'Capability identifier')
    .action(async (slotId: string, capabilityId: string, _options: unknown, command: Command) => {
      const { client, output } = resolveContext(command);
      const emitter = createEmitter(output, command);
      const params: RuntimeCapabilityStopWarmParams = { slotId, capabilityId };
      try {
        const result = await withProgress(
          `Stopping warm ${capabilityId} on ${slotId}`,
          () =>
            client.call<RuntimeCapabilityStopWarmResult>(RuntimeCapabilityMethods.stopWarm, params),
          !emitter.machine,
        );
        if (stopWarmIncomplete(result)) {
          if (!emitter.machine) output.write(`${formatStopWarm(result)}\n`);
          emitter.fail(stopWarmError(result));
          return;
        }
        emit(output, emitter, result, () => formatStopWarm(result));
      } catch (error) {
        emitter.fail(error);
      }
    });

  capability
    .command('acquire')
    .description('Acquire (or restart) one capability for a run')
    .argument('<slotId>', 'Slot identifier')
    .argument('<capabilityId>', 'Capability identifier')
    .requiredOption('--run <runId>', 'Owning run')
    .requiredOption(
      '--reason <text>',
      'Why this capability is needed; recorded on the proof requirement',
    )
    .addOption(
      new Option('--mode <mode>', 'Proof mode for the requirement')
        .choices([...RUNTIME_CAPABILITY_PROOF_MODES])
        .default('state'),
    )
    .option(
      '--revalidate-health',
      'Re-run the provider health check before reusing a lease this run already holds',
    )
    .action(
      async (
        slotId: string,
        capabilityId: string,
        options: CapabilityAcquireOptions,
        command: Command,
      ) => {
        const { client, output } = resolveContext(command);
        const emitter = createEmitter(output, command);
        const params: RuntimeCapabilityAcquireParams = {
          slotId,
          capabilityId,
          ownerRunId: options.run,
          proofRequirement: { capabilityId, reason: options.reason, mode: options.mode },
          ...(options.revalidateHealth ? { revalidateHealth: true } : {}),
        };
        try {
          const result = await withProgress(
            `Acquiring ${capabilityId} on ${slotId}`,
            () =>
              client.call<RuntimeCapabilityAcquireResult>(RuntimeCapabilityMethods.acquire, params),
            !emitter.machine,
          );
          if (!result.ok) {
            if (!emitter.machine) output.write(`${formatCapabilityAcquire(result, params)}\n`);
            emitter.fail(
              Object.assign(new Error(`Acquire refused: ${result.conflict.reason}`), {
                code: 'RUNTIME_CAPABILITY_ACQUIRE_REFUSED',
                userAction:
                  'Resolve the reported conflict — release the other owner, wait out host pressure, or pick an available capability — then acquire again.',
                details: result,
              }),
            );
            return;
          }
          emit(output, emitter, result, () => formatCapabilityAcquire(result, params));
        } catch (error) {
          emitter.fail(error);
        }
      },
    );

  capability
    .command('release')
    .description('Release one capability lease held by a run')
    .argument('<slotId>', 'Slot identifier')
    .requiredOption('--run <runId>', 'Owning run')
    .option('--capability <capabilityId>', 'Release this capability')
    .option('--lease <leaseId>', 'Release this lease')
    .option('--force', 'Retry cleanup with the current provider after provenance changed')
    .option('--stop', 'Stop the provider instead of leaving it warm')
    .action(async (slotId: string, options: CapabilityReleaseOptions, command: Command) => {
      const { client, output } = resolveContext(command);
      const emitter = createEmitter(output, command);
      const params: RuntimeCapabilityReleaseParams = {
        slotId,
        ownerRunId: options.run,
        ...(options.capability ? { capabilityId: options.capability } : {}),
        ...(options.lease ? { leaseId: options.lease } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.stop ? { keepWarm: false } : {}),
      };
      try {
        const result = await withProgress(
          `Releasing capabilities on ${slotId}`,
          () =>
            client.call<RuntimeCapabilityReleaseResult>(RuntimeCapabilityMethods.release, params),
          !emitter.machine,
        );
        if (capabilityReleaseIncomplete(result)) {
          if (!emitter.machine) output.write(`${formatCapabilityRelease(result, params)}\n`);
          emitter.fail(capabilityReleaseError(result, options.run));
          return;
        }
        emit(output, emitter, result, () => formatCapabilityRelease(result, params));
      } catch (error) {
        emitter.fail(error);
      }
    });
}
