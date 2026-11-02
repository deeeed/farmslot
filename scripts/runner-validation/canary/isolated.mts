// Canary cases on an isolated gateway with a remote node (lib/remote-node-stack.mts). Nothing
// here touches the live gateway; every restart happens here.
//
// - lifecycle: a canary run through the whole lifecycle, timed against the step budgets.
// - f324: a canary run replayed from dispatch while its gate card is open.
// - restart cases: a run held at a known point in a step, the gateway restarted (node up, or node
//   away past recovery's node wait), the hold released; the run must end like a same-night
//   no-restart baseline (scripted, so it costs nothing).
// - review: one reviewed run (codex, two model calls) held at its review, its fix round and its
//   re-review, restarting at each; its expected end is derived from the verdicts it recorded.
// - review-past-wait: a reviewer whose turn the proxy answers itself (no model call), restarted
//   with its node away past REVIEW's 120 s reconnect wait.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Run } from '../../../packages/protocol/src/index.js';
import { poll, type Reaper, writeJson } from '../lib/isolated-stack.mjs';
import { type RemoteNodeStack, startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import {
  CANARY_PROJECT,
  CANARY_REPO,
  canaryPack,
  canaryRunParams,
  PIPE_PROJECT,
  projectPacks,
  REVIEW_PROJECT,
  REVIEW_TICKET,
  REVIEWER,
  SEED,
  slotCli,
} from './fixtures.mjs';
import {
  type CheckResult,
  failureText,
  LIFECYCLE_OUTCOME,
  outcomeDifferences,
  outcomeObservations,
  overBudget,
  REVIEWED_OUTCOME,
  reviewVerdicts,
  type RunOutcome,
  runOutcome,
  type SlotView,
  stepTimings,
} from './outcome.mjs';

export const RESTART_STEPS = [
  'dispatch',
  'monitor',
  'human-gate-prep',
  'finalize',
  'release',
] as const;
export type RestartStep = (typeof RESTART_STEPS)[number];
export type Variant = 'node-up' | 'node-away';
type HoldStep = RestartStep | 'review' | 'review-fix';

export interface IsolatedOptions {
  root: string;
  evidence: string;
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
  reaper: Reaper;
  ownerTag: string;
  cliSnapshots: string;
  /** Use this node CLI snapshot instead of building one (a host's deployed snapshot). */
  cliSnapshot?: string;
  budgetsS: Record<string, number>;
  /** Past the 15 s a node RPC waits for its node. */
  nodeAwayMs: number;
  /** For the review fix round's re-review: inside REVIEW's 120 s reconnect wait. */
  reviewFixNodeAwayMs: number;
  /** For review-past-wait: past REVIEW's 120 s reconnect wait. */
  reviewNodeAwayMs: number;
  lifecycle?: boolean;
  nativeCheck?: boolean;
  f324?: boolean;
  restarts?: Array<{ step: RestartStep; variants: Variant[] }>;
  review?: boolean;
  reviewPastWait?: boolean;
  /** Called once the stack exists, so a signal can stop it. */
  onStack?: (stack: RemoteNodeStack) => void;
}

const SETTLED_STEP = new Set(['done', 'failed', 'skipped']);
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
// Statuses of a run that waits for a person's decision (runners/run-progress.ts).
const WAITING = new Set(['needs-decision', 'human-gating', 'blocked', 'review-failed']);
// No visible change for this long with nothing held: the run is not going to move.
const STALL_MS = 6 * 60_000;
const stepStatus = (run: Run, name: string) => run.steps.find((step) => step.name === name)?.status;
const contexts = (run: Run, role: string) =>
  (run.agentContexts ?? []).filter((context) => context.role === role);
const brief = (run: Run) =>
  `${run.status} | ${run.steps.map((step) => `${step.name}:${step.status}`).join(' ')} | decisions ${
    run.decisions
      .map((decision) => `${decision.type}${decision.resolvedAt ? '' : '(open)'}`)
      .join(',') || '-'
  }`;

class Inconclusive extends Error {}

// ---------------------------------------------------------------- run shapes
type Decision = Run['decisions'][number];
type DecisionAction = { resolve: string } | { replay: string };

interface Shape {
  project: string;
  create(slotId: string): Record<string, unknown>;
  /** What the test does with an open decision, or undefined to leave it for a person. */
  decide(decision: Decision, run: Run, state: { replayedAt?: string }): DecisionAction | undefined;
  /** Extra reads each poll makes, as a client would (F324: the inbox refreshes gate readiness). */
  onPoll?(stack: RemoteNodeStack, run: Run): Promise<void>;
  timeoutMs: number;
}

const offered = (decision: Decision, ...ids: string[]) =>
  ids.find((id) => (decision.actions ?? []).some((action) => action.id === id));
const closeGate = (decision: Decision): DecisionAction | undefined => {
  const action =
    decision.type === 'engine_human_gate' ? offered(decision, 'close-as-shipped') : undefined;
  return action ? { resolve: action } : undefined;
};

type ShapeName = 'canary' | 'f324' | 'pipe' | 'review';

const SHAPES: Record<ShapeName, Shape> = {
  canary: {
    project: CANARY_PROJECT,
    create: (slotId) => canaryRunParams(slotId, 'isolated lifecycle'),
    decide: closeGate,
    timeoutMs: 10 * 60_000,
  },
  // F324: replay from dispatch while the first gate card is open, reading the decision inbox as
  // a client does (that refresh is what failed the replayed dispatch). Close the next card.
  f324: {
    project: CANARY_PROJECT,
    create: (slotId) => canaryRunParams(slotId, 'isolated f324'),
    decide: (decision, _run, state) =>
      decision.type !== 'engine_human_gate'
        ? undefined
        : !state.replayedAt
          ? { replay: 'dispatch' }
          : // Only a card the replay presented; the one it found open must have been superseded.
            String(decision.createdAt) > state.replayedAt
            ? closeGate(decision)
            : undefined,
    onPoll: async (stack) => {
      await stack.call('decision.list', {});
    },
    timeoutMs: 15 * 60_000,
  },
  // The restart matrix's pipeline: the same lifecycle, with a worker that can hold (slotCli).
  pipe: {
    project: PIPE_PROJECT,
    create: (slotId) => ({
      project: PIPE_PROJECT,
      flowType: 'dev',
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      ticketOrPr: 'restart invariant pipeline',
      initialContext: 'Scripted restart-invariant run; the worker changes nothing.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      transport: 'tmux',
      // The slot's CLI turns the scenario launch into the project's `work` command (slotCli).
      scripted: { mode: 'scenario', scenario: 'success' },
    }),
    decide: closeGate,
    timeoutMs: 20 * 60_000,
  },
  // A validation dev run (never a publication candidate) whose REVIEW runs codex. Artifact-only,
  // so an output-review card is open while the fix round runs (#1724's case).
  review: {
    project: REVIEW_PROJECT,
    create: (slotId) => ({
      project: REVIEW_PROJECT,
      flowType: 'dev',
      mode: 'validation',
      // A Jira-shaped key passes dev ticket validation; ticketData means nothing is fetched. One
      // per run: a second run on the same ticket raises a collision decision.
      ticketOrPr: `RI-${slotId.replace(/^.*-/, '')}`,
      ticketData: {
        source: 'manual',
        ...REVIEW_TICKET,
        acceptanceCriteria: [],
        affectedArea: 'src',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
      slotId,
      runner: 'scripted',
      model: 'scripted',
      transport: 'tmux',
      scripted: { mode: 'scenario', scenario: 'success' },
      completionPolicy: 'artifact-only',
      reviewMode: 'cold',
      reviewValidationDepth: 'static-code',
      reviewSequence: [{ ...REVIEWER, mode: 'cold' }],
    }),
    decide: () => undefined,
    timeoutMs: 40 * 60_000,
  },
};

// ---------------------------------------------------------------- holds
interface View {
  run: Run;
  slot?: SlotView;
}

/** The run a hold belongs to: its slot, and where its evidence goes. */
interface HoldContext {
  slotId: string;
  slotRepo: string;
  dir: string;
  /** The run as the hold caught it, once it has. */
  held?: Run;
}

interface HoldPhase {
  step: HoldStep;
  restarts: Variant[];
  nodeAwayMs: number;
  /** When to arm: before the run is created, before the test resolves a decision, or on a poll. */
  armAt: 'create' | 'resolve' | ((view: View) => boolean);
  arm(context: HoldContext): Promise<void>;
  held(view: View): boolean;
  /** The step got past the hold point without being held. */
  missed(view: View): boolean;
  release(context: HoldContext): Promise<void>;
  /** A git hold must lift before the new gateway starts: it reads its branch at boot. */
  releaseWhileDown?: boolean;
  /** More to do while the gateway is down, after a release there. */
  whileDown?(context: HoldContext): Promise<void>;
  needsSlot?: boolean;
}

/**
 * A marker under holds/. Its content says what to hold where the fixture reads it (the git and
 * ssh holds match commands against it). Release keeps what the hold caught (`.hit`, and the git
 * calls seen while armed, `.seen`) in the run's evidence.
 */
function marker(
  stack: RemoteNodeStack,
  name: string,
  content: (context: HoldContext) => string = () => 'hold\n',
) {
  const file = path.join(stack.holds, name);
  return {
    arm: (context: HoldContext) => writeFile(file, content(context)),
    hit: () => existsSync(`${file}.hit`),
    release: async (context: HoldContext) => {
      await rm(file, { force: true });
      for (const suffix of ['.hit', '.seen'])
        if (existsSync(`${file}${suffix}`)) {
          await appendFile(
            path.join(context.dir, `hold-${name}${suffix}`),
            await readFile(`${file}${suffix}`, 'utf8'),
          );
          // A later phase arming the same marker must see its own hit.
          await rm(`${file}${suffix}`, { force: true });
        }
    },
  };
}

/** Git calls on the run's own slot checkout; fleet refreshes of other slots go through. */
const slotGit = ({ slotId }: HoldContext) => `/slots/${slotId}( |/|$)`;

export const HOLDS: Record<HoldStep, string> = {
  dispatch:
    "git on the run's slot waits while holds/git exists, armed as soon as DISPATCH runs; released while the gateway is down",
  monitor: 'the scripted worker waits while holds/worker exists, armed before the run starts',
  'human-gate-prep':
    "git on the run's slot waits while holds/git exists, armed as soon as HUMAN_GATE runs, so the gate cannot finish preparing its package; released while the gateway is down",
  finalize:
    "ssh waits while holds/ssh names session-usage.sh, FINALIZE's first slot call; armed as the test resolves the gate, released while the gateway is down",
  release:
    "git on the run's slot waits while holds/git exists, armed once the run is terminal, so the slot teardown cannot finish; released while the gateway is down",
  review:
    "the codex proxy holds the reviewer's output once the node accepted its turn, while holds/review exists",
  'review-fix':
    'the relaunched scripted worker commits its fix with the fix round live, then waits on holds/fix before marking it complete; the gateway restarts with the node up and the fix completes while it is down. Then the codex proxy holds the loop-2 re-review for a restart with the node away',
};

function restartPhase(
  stack: RemoteNodeStack,
  step: RestartStep,
  variant: Variant,
  nodeAwayMs: number,
): HoldPhase {
  const base = { step, restarts: [variant], nodeAwayMs };
  const git = marker(stack, 'git', slotGit);
  switch (step) {
    case 'dispatch':
      return {
        ...base,
        armAt: ({ run }) => stepStatus(run, 'dispatch') === 'running',
        arm: git.arm,
        held: ({ run }) => git.hit() && stepStatus(run, 'dispatch') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'dispatch') ?? ''),
        release: git.release,
        releaseWhileDown: true,
      };
    case 'monitor': {
      const worker = marker(stack, 'worker');
      return {
        ...base,
        armAt: 'create',
        arm: worker.arm,
        held: ({ run }) => worker.hit() && stepStatus(run, 'monitor') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'monitor') ?? ''),
        release: worker.release,
      };
    }
    case 'human-gate-prep': {
      const gateCard = (run: Run) =>
        run.decisions.some((decision) => decision.type === 'engine_human_gate');
      return {
        ...base,
        armAt: ({ run }) => stepStatus(run, 'human-gate') === 'running',
        arm: git.arm,
        held: ({ run }) =>
          git.hit() && stepStatus(run, 'human-gate') === 'running' && !gateCard(run),
        missed: ({ run }) => gateCard(run) || SETTLED_STEP.has(stepStatus(run, 'human-gate') ?? ''),
        release: git.release,
        releaseWhileDown: true,
      };
    }
    case 'finalize': {
      const ssh = marker(stack, 'ssh', () => 'session-usage.sh');
      return {
        ...base,
        armAt: 'resolve',
        arm: ssh.arm,
        held: ({ run }) => ssh.hit() && stepStatus(run, 'finalize') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'finalize') ?? ''),
        release: ssh.release,
        releaseWhileDown: true,
      };
    }
    case 'release':
      return {
        ...base,
        armAt: ({ run }) => TERMINAL.has(run.status),
        arm: git.arm,
        held: ({ run, slot }) =>
          TERMINAL.has(run.status) && git.hit() && slot !== undefined && slot.lifecycle !== 'ready',
        missed: ({ run, slot }) =>
          TERMINAL.has(run.status) && !git.hit() && slot?.lifecycle === 'ready',
        release: git.release,
        releaseWhileDown: true,
        needsSlot: true,
      };
  }
}

/**
 * The reviewed run's holds: its loop-1 reviewer (node up), its fix round (node up, the fix
 * completing while the gateway is down), its loop-2 re-review (node away). A scripted worker has
 * no prompt receipt, so a restart while its fix signal still reads running makes recovery resend
 * the fix prompt, which it cannot accept: the fix finishes during the outage instead (#1724).
 */
function reviewPhases(stack: RemoteNodeStack, reviewFixNodeAwayMs: number): HoldPhase[] {
  const review = marker(stack, 'review');
  const fix = marker(stack, 'fix');
  const fixContext = (run: Run) => contexts(run, 'review-fix').at(-1);
  return [
    {
      step: 'review',
      restarts: ['node-up'],
      nodeAwayMs: reviewFixNodeAwayMs,
      armAt: 'create',
      arm: review.arm,
      held: ({ run }) =>
        review.hit() &&
        stepStatus(run, 'review') === 'running' &&
        contexts(run, 'review').some((context) => context.nativeSession?.acceptedAt),
      missed: ({ run }) =>
        SETTLED_STEP.has(stepStatus(run, 'review') ?? '') || contexts(run, 'review-fix').length > 0,
      release: review.release,
    },
    {
      step: 'review-fix',
      restarts: ['node-up'],
      nodeAwayMs: reviewFixNodeAwayMs,
      armAt: 'create',
      arm: fix.arm,
      held: ({ run }) =>
        fix.hit() &&
        stepStatus(run, 'review') === 'running' &&
        fixContext(run)?.status === 'working',
      missed: ({ run }) =>
        SETTLED_STEP.has(stepStatus(run, 'review') ?? '') || fixContext(run)?.status === 'complete',
      release: fix.release,
      releaseWhileDown: true,
      // The worker marks the fix complete while the gateway is down; the re-review recovery then
      // launches must find its hold armed.
      whileDown: async (context) => {
        const signalFile = context.held && fixContext(context.held)?.signalFile;
        if (!signalFile) throw new Error('The held run has no review-fix signal file');
        await poll(
          'the fix signal to complete while the gateway is down',
          async () => {
            try {
              const raw = await readFile(path.join(context.slotRepo, signalFile), 'utf8');
              return (JSON.parse(raw) as { status?: string }).status === 'complete'
                ? true
                : undefined;
            } catch {
              // Missing or mid-write: the next poll reads the finished file.
              return undefined;
            }
          },
          120_000,
        );
        await review.arm(context);
      },
    },
    {
      step: 'review-fix',
      restarts: ['node-away'],
      nodeAwayMs: reviewFixNodeAwayMs,
      // Armed by the fix phase above, while the gateway was down.
      armAt: 'create',
      arm: async () => {},
      held: ({ run }) =>
        review.hit() &&
        stepStatus(run, 'review') === 'running' &&
        contexts(run, 'review').some(
          (context) => (context.reviewLoopNumber ?? 0) >= 2 && context.nativeSession?.acceptedAt,
        ),
      missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'review') ?? ''),
      release: review.release,
    },
  ];
}

// ---------------------------------------------------------------- one run
interface RestartRecord {
  step: HoldStep;
  variant: Variant;
  downS: number;
  nodeOfflineS?: number;
  before: string;
  after: string;
}

interface ScenarioResult {
  label: string;
  runId: string;
  run: Run;
  outcome: RunOutcome;
  durationS: number;
  /** Seconds per step, and `release`: from the run going terminal until its slot was ready. */
  timingsS: Record<string, number>;
  restarts: RestartRecord[];
  /** Holds the run never reached after an earlier restart. */
  unreached: HoldStep[];
  /** Decision actions the gateway refused. */
  refused: string[];
  evidence: string;
}

export async function runIsolated(options: IsolatedOptions): Promise<CheckResult[]> {
  const { log, evidence } = options;
  const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;
  const restarts = options.restarts ?? [];
  const slots: string[] = [];
  const allocate = (project: string, count: number) =>
    slots.push(...Array.from({ length: count }, (_, index) => `${project}-${index + 1}`));
  allocate(CANARY_PROJECT, (options.lifecycle ? 1 : 0) + (options.f324 ? 1 : 0));
  allocate(
    PIPE_PROJECT,
    restarts.length ? 1 + restarts.reduce((sum, entry) => sum + entry.variants.length, 0) : 0,
  );
  allocate(REVIEW_PROJECT, (options.review ? 1 : 0) + (options.reviewPastWait ? 1 : 0));

  const stack = await startRemoteNodeStack({
    root: options.root,
    evidence,
    machine: 'ri-node',
    slots,
    projects: (holds) => [canaryPack(''), ...projectPacks(holds)],
    seeds: { [CANARY_PROJECT]: CANARY_REPO, [PIPE_PROJECT]: SEED, [REVIEW_PROJECT]: SEED },
    slotFiles: (slotId, fixture) =>
      slotId.startsWith(`${CANARY_PROJECT}-`) ? {} : slotCli(options.root)(slotId, fixture),
    cliSnapshots: options.cliSnapshots,
    ...(options.cliSnapshot ? { cliSnapshot: options.cliSnapshot } : {}),
    ownerTag: options.ownerTag,
    reaper: options.reaper,
    log,
  });
  options.onStack?.(stack);
  const slotCounter: Record<string, number> = {};
  const modelCalls = async () =>
    (await readFile(path.join(stack.holds, 'model-calls.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean).length;

  async function readSlot(slotId: string): Promise<SlotView | undefined> {
    const { fleet } = await stack.call<{
      fleet: { slots: Array<{ slot: string; lifecycle: string; phase?: string | null }> };
    }>('fleet.status');
    return fleet.slots.find((slot) => slot.slot === slotId);
  }

  async function runScenario(
    label: string,
    shapeName: ShapeName,
    phases: HoldPhase[],
  ): Promise<ScenarioResult> {
    const shape = SHAPES[shapeName];
    slotCounter[shape.project] = (slotCounter[shape.project] ?? 0) + 1;
    const slotId = `${shape.project}-${slotCounter[shape.project]}`;
    const dir = path.join(evidence, label);
    await mkdir(dir, { recursive: true });
    const started = Date.now();
    const hold: HoldContext = { slotId, slotRepo: stack.slotRepo(slotId), dir };
    // Matrix workers start once MONITOR watches them (fixtures.mts); one run at a time.
    const monitoring = path.join(stack.holds, 'monitoring');
    await rm(monitoring, { force: true });
    for (const phase of phases) if (phase.armAt === 'create') await phase.arm(hold);
    const armed = new Set(phases.filter((phase) => phase.armAt === 'create'));
    const { run: created } = await stack.call<{ run: Run }>('run.create', shape.create(slotId));
    const runId = created.id;
    await log(`${label}: run created`, { runId, slotId });
    const restartLog: RestartRecord[] = [];
    const unreached: HoldStep[] = [];
    const attempted = new Set<string>();
    const refused: string[] = [];
    const state: { replayedAt?: string } = {};
    const getRun = async () => (await stack.call<{ run: Run }>('run.get', { runId })).run;
    let current = 0;
    let lastBrief = '';
    let changedAt = Date.now();
    let terminalSince: number | undefined;
    const deadline = started + shape.timeoutMs;
    for (;;) {
      if (Date.now() > deadline)
        throw new Inconclusive(
          `${label}: the run did not settle within ${shape.timeoutMs / 60_000} min`,
        );
      const run = await getRun();
      await shape.onPoll?.(stack, run);
      const phase = phases[current];
      const view: View = {
        run,
        ...(phase?.needsSlot || TERMINAL.has(run.status) ? { slot: await readSlot(slotId) } : {}),
      };
      if (stepStatus(run, 'monitor') === 'running' && !existsSync(monitoring))
        await writeFile(monitoring, `${runId}\n`);
      const summary = `${brief(run)}${view.slot ? ` | slot ${view.slot.lifecycle}/${view.slot.phase ?? '-'}` : ''}`;
      if (summary !== lastBrief) {
        await log(`${label}: ${summary}`);
        await appendFile(
          path.join(dir, 'samples.jsonl'),
          `${JSON.stringify({ t: seconds(started), summary })}\n`,
        );
        lastBrief = summary;
        changedAt = Date.now();
      }

      if (phase) {
        if (!armed.has(phase) && typeof phase.armAt === 'function' && phase.armAt(view)) {
          await phase.arm(hold);
          armed.add(phase);
          await log(`${label}: ${phase.step} hold armed`);
        }
        if (armed.has(phase) && phase.held(view)) {
          await log(`${label}: ${phase.step} held`, { run: brief(run) });
          hold.held = run;
          await writeJson(path.join(dir, `run-held-${current + 1}-${phase.step}.json`), run);
          for (const [index, variant] of phase.restarts.entries()) {
            const last = index === phase.restarts.length - 1;
            const restart = await stack.restartGateway({
              ...(variant === 'node-away' ? { nodeAwayMs: phase.nodeAwayMs } : {}),
              ...(last && phase.releaseWhileDown
                ? {
                    whileDown: async () => {
                      await phase.release(hold);
                      await phase.whileDown?.(hold);
                    },
                  }
                : {}),
            });
            const after = await getRun();
            restartLog.push({
              step: phase.step,
              variant,
              downS: Math.round(restart.downMs / 100) / 10,
              ...(restart.nodeOfflineMs !== undefined
                ? { nodeOfflineS: Math.round(restart.nodeOfflineMs / 100) / 10 }
                : {}),
              before: brief(run),
              after: brief(after),
            });
            await log(`${label}: restarted (${variant})`, { after: brief(after) });
          }
          if (!phase.releaseWhileDown) await phase.release(hold);
          await log(`${label}: ${phase.step} released`);
          current += 1;
          continue;
        }
        const stalled = Date.now() - changedAt >= STALL_MS;
        if (phase.missed(view) || stalled) {
          // Before any restart, the hold itself failed. After one, the run went elsewhere than
          // expected: settle it and let the outcome comparison show where.
          if (restartLog.length === 0)
            throw new Inconclusive(
              `${label}: ${phase.step} ${stalled ? 'never reached' : 'moved past'} its hold point (${summary})`,
            );
          unreached.push(...phases.slice(current).map((pending) => pending.step));
          await log(`${label}: after the restarts the run never reached the ${phase.step} hold`, {
            run: summary,
          });
          current = phases.length;
          continue;
        }
      }

      // Decisions the shape answers; a finalize hold arms just before the gate is resolved. A
      // refused action is recorded (the outcome then differs) and not retried.
      let acted = false;
      for (const decision of run.decisions.filter(
        (candidate) => !candidate.resolvedAt && !attempted.has(candidate.id),
      )) {
        const action = shape.decide(decision, run, state);
        if (!action) continue;
        attempted.add(decision.id);
        if (phase?.armAt === 'resolve' && !armed.has(phase)) {
          await phase.arm(hold);
          armed.add(phase);
          await log(`${label}: ${phase.step} hold armed`);
        }
        try {
          if ('replay' in action) {
            state.replayedAt = new Date().toISOString();
            await stack.call('run.replayStep', { runId, stepName: action.replay });
            await log(`${label}: replayed from ${action.replay} with ${decision.type} open`);
          } else {
            await stack.call('run.resolveDecision', {
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

      if (!phase) {
        // Settled: terminal with its slot released, waiting on a person, or unchanged long
        // enough that nothing will move it (a run a restart stranded).
        const unchangedMs = Date.now() - changedAt;
        const waiting =
          WAITING.has(run.status) && run.decisions.some((decision) => !decision.resolvedAt);
        let settled = unchangedMs >= STALL_MS || (waiting && unchangedMs >= 5000);
        if (TERMINAL.has(run.status)) {
          // A released slot is ready. Any other slot state stands only once the orphan
          // reconciler (every 60 s) has had two passes at it.
          terminalSince ??= Date.now();
          settled ||=
            (view.slot?.lifecycle === 'ready' && unchangedMs >= 1500) ||
            Date.now() - terminalSince > 150_000;
        }
        if (settled) {
          const slot = view.slot ?? (await readSlot(slotId));
          await writeJson(path.join(dir, 'run-final.json'), run);
          if (unchangedMs >= STALL_MS)
            await log(`${label}: unchanged for ${STALL_MS / 60_000} min; recording it as settled`);
          const timingsS = stepTimings(run);
          if (terminalSince !== undefined && slot?.lifecycle === 'ready')
            timingsS.release = Math.round((Date.now() - unchangedMs - terminalSince) / 100) / 10;
          return {
            label,
            runId,
            run,
            outcome: runOutcome(run, slot),
            durationS: seconds(started),
            timingsS,
            restarts: restartLog,
            unreached,
            refused,
            evidence: dir,
          };
        }
      }
      const fastPoll = phase && !armed.has(phase) && typeof phase.armAt === 'function';
      await delay(fastPoll ? 100 : 500);
    }
  }

  /** Leaves nothing active: a later restart would otherwise recover this run too. */
  async function retire(runId: string) {
    const { run } = await stack.call<{ run: Run }>('run.get', { runId });
    if (TERMINAL.has(run.status)) return;
    const reason = 'canary: outcome recorded';
    try {
      await stack.call('run.cancel', { runId, reason });
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
        (await stack.call('run.resolveDecision', { runId, ...close, reason }).then(
          () => true,
          () => false,
        ));
      // Its outcome is already recorded; later restarts recover it too, which only adds noise.
      if (!closed) await log('could not retire the run', { runId, error: String(error) });
    }
  }

  /** One scenario as a check; an unverifiable one (a hold that never caught) is `unverified`. */
  async function check(
    base: Pick<CheckResult, 'case' | 'variant' | 'model'> & { hold?: string },
    scenario: () => Promise<ScenarioResult>,
    judge: (
      result: ScenarioResult,
    ) => Pick<CheckResult, 'status' | 'differences' | 'observations'> & Partial<CheckResult>,
  ): Promise<CheckResult> {
    const callsBefore = await modelCalls();
    let result: CheckResult;
    try {
      const scenarioResult = await scenario();
      await retire(scenarioResult.runId);
      result = {
        ...base,
        target: 'isolated',
        modelCalls: (await modelCalls()) - callsBefore,
        runId: scenarioResult.runId,
        durationS: scenarioResult.durationS,
        observed: scenarioResult.outcome,
        timingsS: scenarioResult.timingsS,
        failureText: failureText(scenarioResult.run),
        restarts: scenarioResult.restarts,
        evidence: scenarioResult.evidence,
        ...judge(scenarioResult),
      };
    } catch (error) {
      if (!(error instanceof Inconclusive)) throw error;
      result = {
        ...base,
        target: 'isolated',
        status: 'unverified',
        modelCalls: (await modelCalls()) - callsBefore,
        differences: [],
        observations: [],
        error: error.message,
      };
    }
    await log(`${base.case} ${base.variant}: ${result.status.toUpperCase()}`, {
      differences: result.differences,
      ...(result.observations.length ? { observations: result.observations } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  const results: CheckResult[] = [];
  const unreachedDifferences = (result: ScenarioResult) => [
    ...result.unreached.map(
      (step) => `${step}: after the earlier restarts the run never reached this step's hold`,
    ),
    ...result.refused,
  ];

  if (options.nativeCheck) {
    // The live canary's native round trip, against this node: the gateway routes a session list
    // to the node's native host.
    const started = Date.now();
    let failure: string | undefined;
    await stack
      .call('native.session.list', { executionNodeId: 'ri-node' })
      .catch((error: unknown) => {
        failure = `native.session.list on ri-node failed: ${String(error)}`;
      });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const late = overBudget({ 'native-check': seconds }, options.budgetsS);
    const differences = [...(failure ? [failure] : []), ...late];
    results.push({
      case: 'native-check',
      variant: 'ri-node',
      target: 'isolated',
      status: differences.length ? 'fail' : 'pass',
      model: 'none',
      modelCalls: 0,
      durationS: seconds,
      timingsS: { 'native-check': seconds },
      differences,
      observations: [],
    });
    await log(`native-check ri-node: ${differences.length ? 'FAIL' : 'PASS'}`, {
      seconds,
      differences,
    });
  }

  if (options.lifecycle)
    results.push(
      await check(
        { case: 'lifecycle', variant: 'ri-node', model: 'scripted' },
        () => runScenario('lifecycle', 'canary', []),
        (result) => {
          const differences = [
            ...result.refused,
            ...outcomeDifferences(LIFECYCLE_OUTCOME, result.outcome),
          ];
          const late = overBudget(result.timingsS, options.budgetsS);
          return {
            status: differences.length || late.length ? 'fail' : 'pass',
            differences: [...differences, ...late],
            observations: [],
            overBudget: late,
          };
        },
      ),
    );

  if (options.f324)
    results.push(
      await check(
        { case: 'f324-replay-open-gate', variant: '-', model: 'scripted' },
        () => runScenario('f324-replay-open-gate', 'f324', []),
        (result) => {
          const differences = [
            ...result.refused,
            ...outcomeDifferences(LIFECYCLE_OUTCOME, result.outcome),
          ];
          // The replay must have superseded the card it found open.
          const first = [...result.run.decisions]
            .filter((decision) => decision.type === 'engine_human_gate')
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
          if (first?.resolvedAction !== 'superseded')
            differences.push(
              `the gate card open at the replay ended ${first?.resolvedAction ?? (first ? 'open' : 'missing')}, not superseded`,
            );
          return { status: differences.length ? 'fail' : 'pass', differences, observations: [] };
        },
      ),
    );

  if (restarts.length) {
    const baseline = await runScenario('baseline-pipe', 'pipe', []);
    await retire(baseline.runId);
    await log('baseline pipe', { outcome: baseline.outcome, durationS: baseline.durationS });
    for (const { step, variants } of restarts)
      for (const variant of variants)
        results.push(
          await check(
            { case: step, variant, model: 'scripted', hold: HOLDS[step] },
            () =>
              runScenario(`${step}-${variant}`, 'pipe', [
                restartPhase(stack, step, variant, options.nodeAwayMs),
              ]),
            (result) => {
              const differences = [
                ...unreachedDifferences(result),
                ...outcomeDifferences(baseline.outcome, result.outcome),
              ];
              return {
                status: differences.length ? 'fail' : 'pass',
                differences,
                observations: outcomeObservations(baseline.outcome, result.outcome),
                expected: baseline.outcome,
              };
            },
          ),
        );
  }

  if (options.review) {
    // One reviewed run: two model calls, four restarts; its end is derived from its verdicts.
    const model = `scripted worker, ${REVIEWER.runner} ${REVIEWER.model} reviewer`;
    let verdicts: ReturnType<typeof reviewVerdicts> | undefined;
    const reviewCheck = await check(
      { case: 'review', variant: 'node-up', model, hold: HOLDS.review },
      () => runScenario('review', 'review', reviewPhases(stack, options.reviewFixNodeAwayMs)),
      (result) => {
        verdicts = reviewVerdicts(result.run);
        // No fix round when loop 1 passes: its holds are not reached, which is no difference.
        const expectedReviewers = verdicts.loop1 === 'pass' ? 1 : 2;
        const differences = [
          ...(verdicts.loop1 === 'pass' ? result.refused : unreachedDifferences(result)),
          ...outcomeDifferences(REVIEWED_OUTCOME, result.outcome),
          ...(verdicts.reviewers > expectedReviewers
            ? [
                `${verdicts.reviewers} reviewers ran, expected ${expectedReviewers}: a reviewer was re-launched after a restart`,
              ]
            : []),
        ];
        return {
          status: differences.length ? 'fail' : 'pass',
          differences,
          observations: [
            `verdicts: loop 1 ${verdicts.loop1 ?? '?'}, loop 2 ${verdicts.loop2 ?? '-'}`,
            ...(result.outcome.superseded.length
              ? [`superseded cards: [${result.outcome.superseded.join(', ')}]`]
              : []),
          ],
          expected: { ...REVIEWED_OUTCOME, superseded: [], reviews: [] },
        };
      },
    );
    if (reviewCheck.modelCalls > 2) {
      reviewCheck.status = 'fail';
      reviewCheck.differences.push(
        `${reviewCheck.modelCalls} model calls, expected at most 2: a reviewer was re-launched after a restart`,
      );
    }
    // Loop 2 returning issues is the model's drift, not a restart's: that path is not modelled.
    const loop2Drift = verdicts?.loop2 === 'issues';
    const loop1Pass = verdicts?.loop1 === 'pass';
    const relaunched = reviewCheck.differences.some((entry) => entry.includes('re-launched'));
    if (loop2Drift && reviewCheck.status === 'fail' && !relaunched) {
      reviewCheck.status = 'not-exercised';
      reviewCheck.error = 'loop 2 returned issues (verdict drift): the restarts cannot be judged';
    }
    results.push(reviewCheck);
    results.push({
      ...reviewCheck,
      case: 'review-fix',
      variant: 'node-up+node-away',
      hold: HOLDS['review-fix'],
      // The same run as the review check, whose entry counts its model calls.
      modelCalls: 0,
      observations: [
        ...reviewCheck.observations,
        "shares the review check's run and its model calls",
      ],
      ...(loop1Pass || loop2Drift
        ? {
            status: 'not-exercised',
            error: loop1Pass
              ? 'loop 1 returned no issues (verdict drift): no fix round ran'
              : reviewCheck.error,
          }
        : {}),
    });
  }

  if (options.reviewPastWait) results.push(await reviewPastWait());

  /**
   * A reviewer the proxy accepted without a model call, restarted with its node away past
   * REVIEW's reconnect wait. Passing means REVIEW still runs the same reviewer once the node is
   * back; failing means the review was given up while the reviewer lived.
   */
  async function reviewPastWait(): Promise<CheckResult> {
    const label = 'review-past-wait';
    const review = marker(stack, 'review', () => 'swallow\n');
    const base = {
      case: 'review',
      variant: 'node-away',
      model: `${REVIEWER.runner} ${REVIEWER.model} reviewer, turn answered by the proxy (no model call)`,
      hold: `the codex proxy answers the reviewer's turn itself (holds/review = swallow); restart with the node away ${options.reviewNodeAwayMs / 1000} s`,
    };
    const callsBefore = await modelCalls();
    slotCounter[REVIEW_PROJECT] = (slotCounter[REVIEW_PROJECT] ?? 0) + 1;
    const slotId = `${REVIEW_PROJECT}-${slotCounter[REVIEW_PROJECT]}`;
    const dir = path.join(evidence, label);
    await mkdir(dir, { recursive: true });
    const hold: HoldContext = { slotId, slotRepo: stack.slotRepo(slotId), dir };
    await review.arm(hold);
    const monitoring = path.join(stack.holds, 'monitoring');
    await rm(monitoring, { force: true });
    const started = Date.now();
    const { run: created } = await stack.call<{ run: Run }>(
      'run.create',
      SHAPES.review.create(slotId),
    );
    const getRun = async () =>
      (await stack.call<{ run: Run }>('run.get', { runId: created.id })).run;
    let run: Run;
    try {
      const reviewerOf = (candidate: Run) =>
        contexts(candidate, 'review').find((context) => context.nativeSession?.acceptedAt);
      run = await poll(
        'the swallowed reviewer to be accepted',
        async () => {
          const candidate = await getRun();
          if (stepStatus(candidate, 'monitor') === 'running' && !existsSync(monitoring))
            await writeFile(monitoring, `${created.id}\n`);
          if (TERMINAL.has(candidate.status))
            throw new Inconclusive(
              `${label}: the run ended before its reviewer was held (${brief(candidate)})`,
            );
          return review.hit() &&
            stepStatus(candidate, 'review') === 'running' &&
            reviewerOf(candidate)
            ? candidate
            : undefined;
        },
        10 * 60_000,
      );
      const reviewer = reviewerOf(run)!.id;
      await writeJson(path.join(dir, 'run-held.json'), run);
      const restart = await stack.restartGateway({ nodeAwayMs: options.reviewNodeAwayMs });
      await log(`${label}: restarted (node-away)`, {
        nodeOfflineS: (restart.nodeOfflineMs ?? 0) / 1000,
      });
      // The node is back: give REVIEW 30 s to show whether it kept the reviewer.
      const until = Date.now() + 30_000;
      run = await getRun();
      while (Date.now() < until && stepStatus(run, 'review') === 'running') {
        await delay(500);
        run = await getRun();
      }
      await writeJson(path.join(dir, 'run-final.json'), run);
      const kept =
        stepStatus(run, 'review') === 'running' &&
        contexts(run, 'review').some((context) => context.id === reviewer);
      const differences = kept
        ? []
        : [`REVIEW did not keep its reviewer: ${stepStatus(run, 'review')} (${brief(run)})`];
      await review.release(hold);
      await retire(created.id);
      const result: CheckResult = {
        ...base,
        target: 'isolated',
        status: kept ? 'pass' : 'fail',
        modelCalls: (await modelCalls()) - callsBefore,
        runId: created.id,
        durationS: Math.round((Date.now() - started) / 100) / 10,
        differences,
        observations: [],
        failureText: failureText(run),
        evidence: dir,
      };
      await log(`${label}: ${result.status.toUpperCase()}`, { differences });
      return result;
    } catch (error) {
      if (!(error instanceof Inconclusive)) throw error;
      await review.release(hold);
      return {
        ...base,
        target: 'isolated',
        status: 'unverified',
        modelCalls: 0,
        differences: [],
        observations: [],
        error: error.message,
      };
    }
  }

  return results;
}
