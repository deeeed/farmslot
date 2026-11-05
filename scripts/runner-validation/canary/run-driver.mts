// One scripted run driven to its end, for the live canary and the isolated matrix alike: what the
// test does with its decisions, when it counts as settled, and how it is retired. The isolated
// matrix adds its holds through DriveHooks.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isTerminalRunStatus, type Run } from '../../../packages/protocol/src/index.js';
import { writeJson } from '../lib/isolated-stack.mjs';

import { canaryRunParams, CANARY_PROJECT } from './fixtures.mjs';
import {
  type CheckResult,
  LIFECYCLE_OUTCOME,
  outcomeDifferences,
  overBudget,
  replayedGateDifferences,
  type RunOutcome,
  runOutcome,
  type SlotView,
  stepTimings,
} from './outcome.mjs';

export type Call = <T>(method: string, params?: unknown) => Promise<T>;
export type Log = (event: string, detail?: Record<string, unknown>) => Promise<void>;
export type Decision = Run['decisions'][number];
export type DecisionAction = { resolve: string } | { replay: string };

export interface RunShape {
  project: string;
  create(slotId: string): Record<string, unknown>;
  /** What the test does with an open decision, or undefined to leave it for a person. */
  decide(decision: Decision, run: Run, state: { replayedAt?: string }): DecisionAction | undefined;
  /** Extra reads each poll makes, as a client would (F324: the inbox refreshes gate readiness). */
  onPoll?(call: Call, run: Run): Promise<void>;
  timeoutMs: number;
}

/** The run could not be judged; `runId` is the run it left behind, which the caller retires. */
export class Inconclusive extends Error {
  runId?: string;
}

// Statuses of a run that waits for a person's decision (runners/run-progress.ts).
const WAITING = new Set(['needs-decision', 'human-gating', 'blocked', 'review-failed']);
// No visible change for this long with nothing held: the run is not going to move.
export const STALL_MS = 6 * 60_000;

export const stepStatus = (run: Run, name: string) =>
  run.steps.find((step) => step.name === name)?.status;
export const brief = (run: Run) =>
  `${run.status} | ${run.steps.map((step) => `${step.name}:${step.status}`).join(' ')} | decisions ${
    run.decisions
      .map((decision) => `${decision.type}${decision.resolvedAt ? '' : '(open)'}`)
      .join(',') || '-'
  }`;

const offered = (decision: Decision, ...ids: string[]) =>
  ids.find((id) => (decision.actions ?? []).some((action) => action.id === id));
export const closeGate = (decision: Decision): DecisionAction | undefined => {
  const action =
    decision.type === 'engine_human_gate' ? offered(decision, 'close-as-shipped') : undefined;
  return action ? { resolve: action } : undefined;
};

/** A canary lifecycle run: the gate closed as shipped, the slot released. */
export const canaryShape = (label: string): RunShape => ({
  project: CANARY_PROJECT,
  create: (slotId) => canaryRunParams(slotId, label),
  decide: closeGate,
  timeoutMs: 10 * 60_000,
});

/**
 * F324: replay from dispatch while the first gate card is open, reading the decision inbox as a
 * client does (that refresh is what failed the replayed dispatch). Close the next card.
 */
export const f324Shape = (label: string): RunShape => ({
  project: CANARY_PROJECT,
  create: (slotId) => canaryRunParams(slotId, label),
  decide: (decision, _run, state) =>
    decision.type !== 'engine_human_gate'
      ? undefined
      : !state.replayedAt
        ? { replay: 'dispatch' }
        : // Only a card the replay presented; the one it found open must have been superseded.
          String(decision.createdAt) > state.replayedAt
          ? closeGate(decision)
          : undefined,
  onPoll: async (call) => {
    await call('decision.list', {});
  },
  timeoutMs: 15 * 60_000,
});

export async function readSlot(call: Call, slotId: string): Promise<SlotView | undefined> {
  const { fleet } = await call<{
    fleet: { slots: Array<{ slot: string; lifecycle: string; phase?: string | null }> };
  }>('fleet.status');
  return fleet.slots.find((slot) => slot.slot === slotId);
}

export interface View {
  run: Run;
  slot?: SlotView;
}

export interface DriveHooks {
  /** Subscribe to authoritative changes instead of polling or waiting for a quiet window. */
  onChange?(listener: () => void): () => void;
  /** The run exists; everything after this can leave it behind. */
  onCreated?(runId: string): Promise<void> | void;
  /** Read the slot every poll, not only once the run is terminal. */
  needsSlot?(): boolean;
  /** Each poll, before the test acts; 'again' polls again at once. */
  watch?(view: View, context: { summary: string; changedAt: number }): Promise<'again' | undefined>;
  /** Called with a decision the test is about to resolve or replay from. */
  beforeAct?(decision: Decision): Promise<void>;
  /** Something still has to happen: the run does not count as settled yet. */
  holding?(): boolean;
  pollMs?(): number;
}

export interface DrivenRun {
  runId: string;
  run: Run;
  outcome: RunOutcome;
  durationS: number;
  /** Seconds per step, and `release`: from the run going terminal until its slot was ready. */
  timingsS: Record<string, number>;
  /** Decision actions the gateway refused. */
  refused: string[];
  evidence: string;
}

/**
 * Creates the run and answers its decisions until it settles: terminal with its slot released,
 * waiting on a person, or unchanged long enough that nothing will move it. A refused action is
 * recorded (the outcome then differs) and not retried.
 */
export async function driveRun(options: {
  call: Call;
  log: Log;
  label: string;
  dir: string;
  slotId: string;
  shape: RunShape;
  hooks?: DriveHooks;
}): Promise<DrivenRun> {
  const { call, log, label, dir, slotId, shape, hooks = {} } = options;
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const { run: created } = await call<{ run: Run }>('run.create', shape.create(slotId));
  const runId = created.id;
  let revision = 0;
  let wake: (() => void) | undefined;
  const unsubscribe = hooks.onChange?.(() => {
    revision++;
    wake?.();
  });
  try {
    await hooks.onCreated?.(runId);
    await log(`${label}: run created`, { runId, slotId });
    const attempted = new Set<string>();
    const refused: string[] = [];
    const state: { replayedAt?: string } = {};
    let lastSummary = '';
    let changedAt = Date.now();
    let terminalSince: number | undefined;
    const deadline = started + shape.timeoutMs;
    for (;;) {
      const readRevision = revision;
      if (Date.now() > deadline)
        throw new Inconclusive(
          `${label}: the run did not settle within ${shape.timeoutMs / 60_000} min`,
        );
      const { run } = await call<{ run: Run }>('run.get', { runId });
      await shape.onPoll?.(call, run);
      const terminal = isTerminalRunStatus(run.status);
      const view: View = {
        run,
        ...(hooks.needsSlot?.() || terminal ? { slot: await readSlot(call, slotId) } : {}),
      };
      const summary = `${brief(run)}${view.slot ? ` | slot ${view.slot.lifecycle}/${view.slot.phase ?? '-'}` : ''}`;
      if (summary !== lastSummary) {
        await log(`${label}: ${summary}`);
        await appendFile(
          path.join(dir, 'samples.jsonl'),
          `${JSON.stringify({ t: seconds(), summary })}\n`,
        );
        lastSummary = summary;
        changedAt = Date.now();
      }
      if ((await hooks.watch?.(view, { summary, changedAt })) === 'again') continue;

      let acted = false;
      for (const decision of run.decisions.filter(
        (candidate) => !candidate.resolvedAt && !attempted.has(candidate.id),
      )) {
        const action = shape.decide(decision, run, state);
        if (!action) continue;
        attempted.add(decision.id);
        await hooks.beforeAct?.(decision);
        try {
          if ('replay' in action) {
            state.replayedAt = new Date().toISOString();
            await call('run.replayStep', { runId, stepName: action.replay });
            await log(`${label}: replayed from ${action.replay} with ${decision.type} open`);
          } else {
            await call('run.resolveDecision', {
              runId,
              decisionId: decision.id,
              actionId: action.resolve,
            });
            await log(`${label}: resolved ${decision.type} with ${action.resolve}`);
          }
        } catch (error) {
          refused.push(
            `${'replay' in action ? `replay from ${action.replay}` : `resolving ${decision.type}`} was refused: ${String(error)}`,
          );
          await log(`${label}: ${refused.at(-1)}`);
        }
        acted = true;
        break;
      }
      if (acted) continue;

      if (!hooks.holding?.()) {
        const unchangedMs = Date.now() - changedAt;
        const waiting =
          WAITING.has(run.status) && run.decisions.some((decision) => !decision.resolvedAt);
        let settled =
          unchangedMs >= STALL_MS || (waiting && (Boolean(hooks.onChange) || unchangedMs >= 5000));
        if (terminal) {
          // A released slot is ready. Any other slot state stands only once the orphan
          // reconciler (every 60 s) has had two passes at it.
          terminalSince ??= Date.now();
          settled ||=
            (view.slot?.lifecycle === 'ready' &&
              (Boolean(hooks.onChange) || unchangedMs >= 1500)) ||
            Date.now() - terminalSince > 150_000;
        }
        if (settled) {
          const slot = view.slot ?? (await readSlot(call, slotId));
          await writeJson(path.join(dir, 'run-final.json'), run);
          if (unchangedMs >= STALL_MS)
            await log(`${label}: unchanged for ${STALL_MS / 60_000} min; recording it as settled`);
          const timingsS = stepTimings(run);
          if (terminalSince !== undefined && slot?.lifecycle === 'ready')
            timingsS.release = Math.round((changedAt - terminalSince) / 100) / 10;
          return {
            runId,
            run,
            outcome: runOutcome(run, slot),
            durationS: seconds(),
            timingsS,
            refused,
            evidence: dir,
          };
        }
      }
      if (hooks.onChange) {
        if (revision !== readRevision) continue;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              wake = undefined;
              reject(new Inconclusive(`${label}: no change before its deadline`));
            },
            Math.max(1, deadline - Date.now()),
          );
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      } else await delay(hooks.pollMs?.() ?? 500);
    }
  } catch (error) {
    if (error instanceof Inconclusive) error.runId ??= runId;
    throw error;
  } finally {
    unsubscribe?.();
  }
}

/** Leaves the run inactive; what went wrong if it could not. */
export async function retire(call: Call, runId: string): Promise<string | undefined> {
  const { run } = await call<{ run: Run }>('run.get', { runId });
  if (isTerminalRunStatus(run.status)) return undefined;
  const reason = 'canary: outcome recorded';
  try {
    await call('run.cancel', { runId, reason });
    return undefined;
  } catch (error) {
    // A run held for a result decision refuses cancel: close it through that decision.
    const close = run.decisions
      .filter((decision) => !decision.resolvedAt)
      .flatMap((decision) =>
        (decision.actions ?? [])
          .filter((action) => /close/.test(action.id))
          .map((action) => ({ decisionId: decision.id, actionId: action.id })),
      )[0];
    const closed =
      close &&
      (await call('run.resolveDecision', { runId, ...close, reason }).then(
        () => true,
        () => false,
      ));
    return closed ? undefined : String(error);
  }
}

/** What a lifecycle or F324 run ended as, against what it should. */
export function judgeLifecycle(
  kind: 'lifecycle' | 'f324-replay-open-gate',
  result: DrivenRun,
  budgetsS: Record<string, number>,
): Pick<CheckResult, 'status' | 'differences' | 'observations' | 'overBudget'> {
  const differences = [
    ...result.refused,
    ...outcomeDifferences(LIFECYCLE_OUTCOME, result.outcome),
    ...(kind === 'f324-replay-open-gate' ? replayedGateDifferences(result.run) : []),
  ];
  const late = kind === 'lifecycle' ? overBudget(result.timingsS, budgetsS) : [];
  return {
    status: differences.length || late.length ? 'fail' : 'pass',
    differences: [...differences, ...late],
    observations: [],
    overBudget: late,
  };
}

/** A zero-inference native round trip: the gateway routes a session list to the node's host. */
export async function nativeCheck(
  call: Call,
  executionNodeId: string,
  budgetsS: Record<string, number>,
  target: CheckResult['target'],
): Promise<CheckResult> {
  const started = Date.now();
  let failure: string | undefined;
  await call('native.session.list', { executionNodeId }).catch((error: unknown) => {
    failure = `native.session.list on ${executionNodeId} failed: ${String(error)}`;
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const late = overBudget({ 'native-check': seconds }, budgetsS);
  const differences = [...(failure ? [failure] : []), ...late];
  return {
    case: 'native-check',
    variant: executionNodeId,
    target,
    status: differences.length ? 'fail' : 'pass',
    model: 'none',
    modelCalls: 0,
    durationS: seconds,
    timingsS: { 'native-check': seconds },
    differences,
    observations: [],
    overBudget: late,
  };
}
