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
// - worker-survives: a run held with its worker or reviewer mid-turn in DISPATCH, MONITOR, REVIEW,
//   its fix round, HUMAN_GATE package prep or FINALIZE, the gateway restarted with the node up; the
//   worker must stay alive (no kill, no /exit), the step must resume and the run end like its
//   baseline. Zero inference: the reviewer's turns are answered by the test (scripted review).
//   Its monitor-transport-abort hold is a Pi-runner worker in MONITOR whose model stream drops as
//   the gateway restarts (F328): Pi reports the turn failed, the worker is alive.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { isTerminalRunStatus, type Run } from '../../../packages/protocol/src/index.js';
import { alive, listProcesses, poll, type Reaper, writeJson } from '../lib/isolated-stack.mjs';
import { type RemoteNodeStack, startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import {
  CANARY_PROJECT,
  CANARY_REPO,
  canaryPack,
  claudeRunParams,
  fakeClaude,
  fakePi,
  PI_TURN_FAILURE,
  piRunParams,
  PIPE_PROJECT,
  pipeRunParams,
  projectPacks,
  REVIEW_PROJECT,
  REVIEWER,
  reviewRunParams,
  SEED,
  slotCli,
} from './fixtures.mjs';
import {
  type CheckResult,
  failureText,
  LIFECYCLE_OUTCOME,
  outcomeDifferences,
  outcomeObservations,
  REVIEWED_OUTCOME,
  reviewDriftExcuses,
  reviewVerdicts,
} from './outcome.mjs';
import {
  brief,
  canaryShape,
  closeGate,
  type DrivenRun,
  driveRun,
  f324Shape,
  Inconclusive,
  judgeLifecycle,
  nativeCheck,
  retire,
  type RunShape,
  STALL_MS,
  stepStatus,
  type View,
} from './run-driver.mjs';

export const RESTART_STEPS = [
  'dispatch',
  'monitor',
  'human-gate-prep',
  'finalize',
  'release',
] as const;
export type RestartStep = (typeof RESTART_STEPS)[number];
export type Variant = 'node-up' | 'node-away';
export const SURVIVE_STEPS = [
  'dispatch',
  'dispatch-claude-readiness',
  'dispatch-claude-keys',
  'dispatch-claude-verified',
  'monitor',
  'review',
  'review-fix',
  'human-gate-prep',
  'finalize',
  'monitor-transport-abort',
] as const;
export type SurviveStep = (typeof SURVIVE_STEPS)[number];
type HoldStep = RestartStep | SurviveStep;
// How long a worker is watched after the restart before its hold lifts: past a native request's
// 30 s timeout, so the resumed step's first node calls have answered or failed by then.
const SURVIVE_OBSERVE_MS = 45_000;
const LOSS_SETTLE_MS = 5_000;
// The launch's session capture gives up after 20 s on a runner that has reported no session yet.
const READINESS_WAIT_MS = 30_000;
const TRANSPORT_ABORT = /\bterminated\b|abort|ECONNRESET|socket hang up|connection reset/i;

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
  survive?: SurviveStep[];
  /** Called with each check as it finishes, so an interrupted canary still reports it. */
  onCheck: (check: CheckResult) => void;
  /** Given what stops the stack before it starts, so a signal can stop it at any point. */
  onCleanup?: (cleanup: () => Promise<string[]>) => void;
}

const SETTLED_STEP = new Set(['done', 'failed', 'skipped']);
const contexts = (run: Run, role: string) =>
  (run.agentContexts ?? []).filter((context) => context.role === role);

// ---------------------------------------------------------------- run shapes
interface Shape extends RunShape {
  /** The proxy swallows every reviewer turn and the test answers it (scriptedReviewer). */
  scriptedReview?: boolean;
}

type ShapeName = 'canary' | 'f324' | 'pipe' | 'pi' | 'claude' | 'review' | 'scripted-review';

const SHAPES: Record<ShapeName, Shape> = {
  canary: canaryShape('isolated lifecycle'),
  f324: f324Shape('isolated f324'),
  pipe: { project: PIPE_PROJECT, create: pipeRunParams, decide: closeGate, timeoutMs: 20 * 60_000 },
  pi: { project: PIPE_PROJECT, create: piRunParams, decide: closeGate, timeoutMs: 20 * 60_000 },
  claude: {
    project: PIPE_PROJECT,
    create: claudeRunParams,
    decide: closeGate,
    timeoutMs: 20 * 60_000,
  },
  review: {
    project: REVIEW_PROJECT,
    create: reviewRunParams,
    decide: () => undefined,
    timeoutMs: 40 * 60_000,
  },
  // The same reviewed run with no model call: loop 1 finds the leftover helper, loop 2 passes.
  'scripted-review': {
    project: REVIEW_PROJECT,
    create: reviewRunParams,
    decide: () => undefined,
    scriptedReview: true,
    timeoutMs: 20 * 60_000,
  },
};

// ---------------------------------------------------------------- holds
/** The run a hold belongs to: its slot, and where its evidence goes. */
interface HoldContext {
  slotId: string;
  slotRepo: string;
  dir: string;
  /** The run as the hold caught it, once it has. */
  held?: Run;
  /** At the re-review's hold: the fix round's commit removed what the first review flagged. */
  fixLanded?: boolean;
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
  /** Armed before the run is created, whatever `armAt` says (an idle runner). */
  prepare?(context: HoldContext): Promise<void>;
  /** Watch the run's worker after the restart, before the release; `release` lifts what kept it. */
  survive?: {
    release?(context: HoldContext): Promise<void>;
    /** Nothing it holds can be lost: the restart may stop and relaunch this worker. */
    relaunches?: boolean;
  };
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

export const HOLDS: Record<RestartStep | 'review' | 'review-fix', string> = {
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
        armAt: ({ run }) => isTerminalRunStatus(run.status),
        arm: git.arm,
        held: ({ run, slot }) =>
          isTerminalRunStatus(run.status) &&
          git.hit() &&
          slot !== undefined &&
          slot.lifecycle !== 'ready',
        missed: ({ run, slot }) =>
          isTerminalRunStatus(run.status) && !git.hit() && slot?.lifecycle === 'ready',
        release: git.release,
        releaseWhileDown: true,
        needsSlot: true,
      };
  }
}

const fixContext = (run: Run) => contexts(run, 'review-fix').at(-1);
const reviewHoldMissed = ({ run }: View) =>
  SETTLED_STEP.has(stepStatus(run, 'review') ?? '') || contexts(run, 'review-fix').length > 0;
/** Held with the fix worker mid-turn in its round. */
const fixRoundHold = (
  fix: ReturnType<typeof marker>,
): Pick<HoldPhase, 'arm' | 'held' | 'missed' | 'release'> => ({
  arm: fix.arm,
  held: ({ run }) =>
    fix.hit() && stepStatus(run, 'review') === 'running' && fixContext(run)?.status === 'working',
  missed: ({ run }) =>
    SETTLED_STEP.has(stepStatus(run, 'review') ?? '') || fixContext(run)?.status === 'complete',
  release: fix.release,
});

/**
 * The reviewed run's holds: its loop-1 reviewer (node up), its fix round (node up, the fix
 * completing while the gateway is down), its loop-2 re-review (node away). A scripted worker has
 * no prompt receipt, so a restart while its fix signal still reads running makes recovery resend
 * the fix prompt, which it cannot accept: the fix finishes during the outage instead (#1724).
 */
function reviewPhases(stack: RemoteNodeStack, reviewFixNodeAwayMs: number): HoldPhase[] {
  const review = marker(stack, 'review');
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
      missed: reviewHoldMissed,
      release: review.release,
    },
    {
      step: 'review-fix',
      restarts: ['node-up'],
      nodeAwayMs: reviewFixNodeAwayMs,
      armAt: 'create',
      ...fixRoundHold(marker(stack, 'fix')),
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
      // Read after the restarts: recovery could still lose the fix before the re-review reads it.
      release: async (context) => {
        context.fixLanded = fixInCheckout(context.slotRepo);
        await review.release(context);
      },
    },
  ];
}

/** The fix round's commit is at HEAD: the debug file it removes is gone, the source it fixes is kept. */
function fixInCheckout(slotRepo: string): boolean {
  try {
    const present = execFileSync(
      'git',
      ['-C', slotRepo, 'ls-tree', '--name-only', 'HEAD', '--', 'src/'],
      { encoding: 'utf8' },
    ).split('\n');
    return present.includes('src/format-name.ts') && !present.includes('src/debug-trace.ts');
  } catch {
    return false;
  }
}

export const SURVIVE_HOLDS: Record<SurviveStep, string> = {
  dispatch:
    "the scripted runner arms a tmux hold when it starts, so DISPATCH's next tmux call waits with the worker launched; the worker waits on holds/worker; the tmux hold lifts while the gateway is down",
  'dispatch-claude-readiness':
    'a Claude-runner worker (no model) stays starting up, so DISPATCH is in its readiness wait with nothing typed; lifts while the gateway is down. A relaunch is correct here',
  'dispatch-claude-keys':
    "a Claude-runner worker (no model) accepts its typed prompt and arms a tmux hold, so DISPATCH's verification waits; the worker waits on holds/worker; the tmux hold lifts while the gateway is down",
  'dispatch-claude-verified':
    'a Claude-runner worker (no model) withholds its session, so DISPATCH is still recapturing it after recording verified delivery; the worker waits on holds/worker',
  monitor: 'the scripted worker waits on holds/worker',
  review:
    "the codex proxy swallows the reviewer's turn (no model call); the test answers it after the watch",
  'review-fix':
    'the relaunched worker commits its fix with the fix round live, then waits on holds/fix; the scripted reviewer returned issues in loop 1 and passes loop 2',
  'human-gate-prep':
    "the scripted runner stays alive after its work (holds/idle); git on the run's slot waits while HUMAN_GATE prepares its package, released while the gateway is down",
  finalize:
    "the scripted runner stays alive after its work (holds/idle); ssh waits on FINALIZE's session-usage.sh call, released after the watch",
  'monitor-transport-abort':
    "a Pi-runner worker (no model) waits on holds/worker; while the gateway is down it records StopFailure 'terminated' on its live session and pane through the real hook writer",
};

/**
 * A worker-survives hold: the run held with its worker (or reviewer) mid-turn, a restart with the
 * node up, the worker watched, then the hold lifted. The scripted runner exits once its work is
 * done, so for HUMAN_GATE and FINALIZE it is kept alive as an interactive runner would idle.
 */
function survivePhase(
  stack: RemoteNodeStack,
  step: SurviveStep,
  reviewer: ScriptedReviewer,
): HoldPhase {
  const base = { step, restarts: ['node-up'] as Variant[], nodeAwayMs: 0 };
  const worker = marker(stack, 'worker');
  const idle = marker(stack, 'idle');
  switch (step) {
    case 'dispatch':
    case 'dispatch-claude-keys': {
      const tmux = marker(stack, 'tmux');
      const armFile = path.join(stack.holds, 'tmux.arm');
      return {
        ...base,
        armAt: 'create',
        arm: async (context) => {
          await worker.arm(context);
          // Any tmux call once the worker has it armed: one run at a time, so they are DISPATCH's.
          await writeFile(armFile, '.\n');
        },
        held: ({ run }) => tmux.hit() && stepStatus(run, 'dispatch') === 'running',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'dispatch') ?? ''),
        release: async (context) => {
          await rm(armFile, { force: true });
          await tmux.release(context);
        },
        releaseWhileDown: true,
        survive: { release: worker.release },
      };
    }
    case 'dispatch-claude-readiness': {
      const startup = marker(stack, 'claude-startup');
      let startupSeenAt = 0;
      return {
        ...base,
        armAt: 'create',
        arm: startup.arm,
        // Past the launch's session capture, DISPATCH polls the pane for a ready prompt.
        held: ({ run }) => {
          if (!startup.hit() || stepStatus(run, 'dispatch') !== 'running') return false;
          startupSeenAt ||= Date.now();
          return Date.now() - startupSeenAt >= READINESS_WAIT_MS;
        },
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'dispatch') ?? ''),
        release: startup.release,
        releaseWhileDown: true,
        survive: { relaunches: true },
      };
    }
    case 'dispatch-claude-verified': {
      const lateSession = marker(stack, 'claude-late-session');
      return {
        ...base,
        armAt: 'create',
        arm: async (context) => {
          await worker.arm(context);
          await lateSession.arm(context);
        },
        held: ({ run }) =>
          stepStatus(run, 'dispatch') === 'running' &&
          typeof run.steps.find((entry) => entry.name === 'dispatch')?.outputs
            ?.promptDeliveryVerifiedAt === 'string',
        missed: ({ run }) => SETTLED_STEP.has(stepStatus(run, 'dispatch') ?? ''),
        release: lateSession.release,
        survive: { release: worker.release },
      };
    }
    case 'monitor':
      return { ...restartPhase(stack, 'monitor', 'node-up', 0), survive: {} };
    case 'human-gate-prep':
      return {
        ...restartPhase(stack, 'human-gate-prep', 'node-up', 0),
        prepare: idle.arm,
        survive: { release: idle.release },
      };
    case 'finalize':
      return {
        ...restartPhase(stack, 'finalize', 'node-up', 0),
        // Held through the restart: once FINALIZE goes on, the slot release stops the worker.
        releaseWhileDown: false,
        prepare: idle.arm,
        survive: { release: idle.release },
      };
    case 'review':
      return {
        ...base,
        armAt: 'create',
        arm: async () => {},
        held: ({ run }) => {
          const pending = reviewer.pending(run);
          return (
            stepStatus(run, 'review') === 'running' &&
            pending !== undefined &&
            (pending.reviewLoopNumber ?? 1) === 1
          );
        },
        missed: reviewHoldMissed,
        // The scripted reviewer answers the turn once this phase is past.
        release: async () => {},
        survive: {},
      } satisfies HoldPhase;
    case 'review-fix': {
      return {
        ...base,
        armAt: 'create',
        ...fixRoundHold(marker(stack, 'fix')),
        survive: {},
      } satisfies HoldPhase;
    }
    case 'monitor-transport-abort': {
      const turnFailure = marker(stack, PI_TURN_FAILURE, () => 'terminated\n');
      return {
        ...restartPhase(stack, 'monitor', 'node-up', 0),
        whileDown: async (context) => {
          await turnFailure.arm(context);
          await poll(
            'the worker to record its failed turn',
            async () => (turnFailure.hit() ? true : undefined),
            15_000,
          );
          await turnFailure.release(context);
        },
        survive: {},
      };
    }
  }
}

// ---------------------------------------------------------------- scripted reviewer
type AgentContext = NonNullable<Run['agentContexts']>[number];

interface ScriptedReviewer {
  /** Arms holds/review to swallow every reviewer turn; clears what an earlier run left. */
  start(): Promise<void>;
  /** The accepted reviewer whose swallowed turn the test has not answered. */
  pending(run: Run): AgentContext | undefined;
  /** The reviewer turns the proxy swallowed: one per reviewer unless a prompt was sent again. */
  turns(): number;
  /** Answers it as the fixture's review template asks: loop 1 issues, later loops pass. */
  answer(run: Run, slotRepo: string): Promise<string | undefined>;
  stop(dir: string): Promise<void>;
}

const execFileAsync = promisify(execFile);

function scriptedReviewer(stack: RemoteNodeStack): ScriptedReviewer {
  const hold = path.join(stack.holds, 'review');
  const answered = new Set<string>();
  // The proxy logs `… swallowed` per turn it answered and `… completed` per batch it ended.
  const count = (word: string) =>
    (existsSync(`${hold}.hit`) ? readFileSync(`${hold}.hit`, 'utf8') : '')
      .split('\n')
      .filter((line) => line.endsWith(word)).length;
  return {
    async start() {
      answered.clear();
      await rm(`${hold}.hit`, { force: true });
      await writeFile(hold, 'swallow\n');
    },
    turns: () => count(' swallowed'),
    pending(run) {
      if (count(' swallowed') <= answered.size) return undefined;
      return contexts(run, 'review').find(
        (context) => context.nativeSession?.acceptedAt && !answered.has(context.id),
      );
    },
    async answer(run, slotRepo) {
      const context = this.pending(run);
      if (!context?.taskFile || !context.signalFile || !context.reviewResultFile) return undefined;
      answered.add(context.id);
      const loop = context.reviewLoopNumber ?? 1;
      const issues = loop === 1;
      const taskDir = path.join(slotRepo, path.dirname(context.taskFile));
      const finding = {
        file: 'src/debug-trace.ts',
        line: 1,
        description: 'Leftover debugging helper (a debugger statement and console.log); remove it.',
        severity: 'major',
      };
      await writeFile(
        path.join(taskDir, 'artifacts', `review-feedback.${context.id}.md`),
        [
          `# Review: ${run.ticketOrPr}`,
          '',
          `## Verdict: ${issues ? 'ISSUES' : 'PASS'}`,
          '',
          '## Summary',
          issues
            ? 'Adds formatName and leaves a debugging helper behind.'
            : 'Adds formatName; the debugging helper is gone.',
          '',
          '## Issues',
          ...(issues ? [`- **${finding.file}:${finding.line}** — ${finding.description}`] : []),
          '',
          '## Follow-ups',
          '- None.',
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(taskDir, context.reviewResultFile),
        `${JSON.stringify({ schemaVersion: 1, verdict: issues ? 'issues' : 'pass', issues: issues ? [finding] : [] })}\n`,
      );
      const checklist = path.basename(context.taskFile);
      // In the environment the reviewer's own commands get (the proxy records it, secrets left out).
      const env = JSON.parse(await readFile(`${hold}-env.json`, 'utf8')) as NodeJS.ProcessEnv;
      const mark = async (...args: string[]) => {
        try {
          await execFileAsync(
            path.join(taskDir, 'mark'),
            ['--checklist', checklist, '--signal', path.basename(context.signalFile!), ...args],
            { cwd: slotRepo, env },
          );
        } catch (error) {
          const { stdout, stderr } = error as { stdout?: string; stderr?: string };
          throw new Inconclusive(
            `the scripted reviewer's mark ${args.join(' ')} failed: ${`${stdout ?? ''}${stderr ?? ''}`.trim() || String(error)}`,
          );
        }
      };
      const steps = (await readFile(path.join(taskDir, checklist), 'utf8')).match(
        /^- \[ \]/gm,
      )?.length;
      await mark('start');
      for (let step = 1; step < (steps ?? 1); step++) await mark(String(step));
      await mark('complete', '--mark-last');
      // End the swallowed turn, as the reviewer's own turn would end.
      const before = count(' completed');
      await writeFile(hold, 'complete\n');
      await poll(
        'the proxy to end the swallowed turn',
        async () => (count(' completed') > before ? true : undefined),
        15_000,
      ).catch(() => undefined);
      await writeFile(hold, 'swallow\n');
      return `loop ${loop}: ${issues ? 'issues' : 'pass'}`;
    },
    async stop(dir) {
      await rm(hold, { force: true });
      await rm(`${hold}-env.json`, { force: true });
      if (existsSync(`${hold}.hit`)) {
        await appendFile(path.join(dir, 'hold-review.hit'), await readFile(`${hold}.hit`, 'utf8'));
        await rm(`${hold}.hit`, { force: true });
      }
    },
  };
}

// ---------------------------------------------------------------- watching a worker
interface WorkerSnapshot {
  panes: Array<{ paneId: string; panePid: number }>;
  processes: Array<{ pid: number; command: string }>;
  reviewers: string[];
  stopsOffset: number;
}

/** The run's tmux panes, the runner under them, and any reviewer app-server. */
function snapshotWorker(stack: RemoteNodeStack, slotId: string, run: Run): WorkerSnapshot {
  const panes = stack.panes(slotId).filter((pane) => !pane.dead);
  const table = listProcesses();
  const under = new Set<number>();
  const queue = panes.map((pane) => pane.panePid);
  while (queue.length) {
    const parent = queue.pop()!;
    for (const row of table)
      if (row.ppid === parent && !under.has(row.pid)) {
        under.add(row.pid);
        queue.push(row.pid);
      }
  }
  const stops = path.join(stack.holds, 'tmux-stops.log');
  return {
    panes: panes.map(({ paneId, panePid }) => ({ paneId, panePid })),
    processes: table
      .filter(
        (row) =>
          (under.has(row.pid) &&
            (row.command.includes('scripted-runner') ||
              row.command.includes(path.join(stack.fixture, 'bin', 'pi')) ||
              row.command.includes(path.join(stack.fixture, 'bin', 'claude')))) ||
          (contexts(run, 'review').length > 0 &&
            row.command.includes(stack.fixture) &&
            /codex-proxy\.cjs.*app-server/.test(row.command)),
      )
      .map(({ pid, command }) => ({ pid, command })),
    reviewers: contexts(run, 'review').map((context) => context.id),
    stopsOffset: existsSync(stops) ? statSync(stops).size : 0,
  };
}

/** What the restart did to the watched worker: empty while everything it had stays alive. */
async function watchWorker(
  stack: RemoteNodeStack,
  slotId: string,
  snapshot: WorkerSnapshot,
  getRun: () => Promise<Run>,
  step: HoldStep,
): Promise<string[]> {
  const stops = path.join(stack.holds, 'tmux-stops.log');
  const deadline = Date.now() + SURVIVE_OBSERVE_MS;
  let until = deadline;
  let losing = false;
  for (;;) {
    const lost: string[] = [];
    const panes = stack.panes(slotId);
    for (const pane of snapshot.panes) {
      const now = panes.find((candidate) => candidate.paneId === pane.paneId);
      if (!now) lost.push(`worker pane ${pane.paneId} is gone`);
      else if (now.dead) lost.push(`worker pane ${pane.paneId} is dead`);
      else if (now.panePid !== pane.panePid)
        lost.push(
          `worker pane ${pane.paneId} was respawned (pid ${pane.panePid} -> ${now.panePid})`,
        );
    }
    for (const watched of snapshot.processes)
      if (!alive(watched.pid))
        lost.push(`pid ${watched.pid} exited: ${watched.command.slice(0, 120)}`);
    if (existsSync(stops)) {
      const text = await readFile(stops, 'utf8');
      for (const line of text.slice(snapshot.stopsOffset).split('\n').filter(Boolean))
        lost.push(`tmux stop sent: ${line.slice(0, 200)}`);
    }
    // Read after the worker: a run already done when its worker went is the slot release
    // stopping it, as it should, not the restart.
    const run = await getRun();
    const failed = run.steps.filter((step) => step.status === 'failed');
    if (step === 'finalize' && run.status === 'done' && !failed.length) return [];
    const relaunched = contexts(run, 'review').filter(
      (context) => !snapshot.reviewers.includes(context.id),
    );
    if (snapshot.reviewers.length && relaunched.length)
      lost.push(
        `a new reviewer was launched: ${relaunched.map((context) => context.id).join(', ')}`,
      );
    if (failed.length || isTerminalRunStatus(run.status))
      lost.push(`the run went ${run.status}: ${failureText(run) || brief(run)}`);
    // A failure's teardown follows it: keep watching a little, to report what it did to the worker.
    if (lost.length && !losing) {
      losing = true;
      until = Date.now() + LOSS_SETTLE_MS;
    } else if (losing && !lost.length) {
      // One bad read (a tmux error reads as no panes) must not shorten the watch.
      losing = false;
      until = deadline;
    }
    if (Date.now() > until) return lost;
    await delay(500);
  }
}

/** The reviews a survive hold must still have run: the outcome comparison doesn't see them. */
function reviewRoundDifferences(scenario: ScenarioResult, baseline: ScenarioResult): string[] {
  const seen = reviewVerdicts(scenario.run);
  const expected = reviewVerdicts(baseline.run);
  return [
    ...(seen.loop2 === 'pass'
      ? []
      : [`re-review: expected pass, observed ${seen.loop2 ?? 'none'}`]),
    ...(seen.reviewers === expected.reviewers
      ? []
      : [`${seen.reviewers} reviewers ran, expected ${expected.reviewers}`]),
    ...(scenario.reviewerTurns === seen.reviewers
      ? []
      : [`${scenario.reviewerTurns ?? 0} reviewer turns for ${seen.reviewers} reviewers`]),
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

interface ScenarioResult extends DrivenRun {
  label: string;
  restarts: RestartRecord[];
  /** Holds the run never reached after an earlier restart. */
  unreached: HoldStep[];
  /** Under a scripted review: the reviewer turns the proxy swallowed. */
  reviewerTurns?: number;
  /** For a worker-survives hold: what was watched, and what the restart did to it. */
  watched?: string[];
  survival?: string[];
  fixLanded?: boolean;
}

export async function runIsolated(options: IsolatedOptions): Promise<void> {
  const { log, evidence, onCheck } = options;
  const restarts = options.restarts ?? [];
  const survive = options.survive ?? [];
  const scriptedReviewStep = (step: SurviveStep) => step === 'review' || step === 'review-fix';
  const survivePipe = survive.filter((step) => !scriptedReviewStep(step)).length;
  const surviveReview = survive.filter(scriptedReviewStep).length;
  const slots: string[] = [];
  const allocate = (project: string, count: number) =>
    slots.push(...Array.from({ length: count }, (_, index) => `${project}-${index + 1}`));
  allocate(CANARY_PROJECT, (options.lifecycle ? 1 : 0) + (options.f324 ? 1 : 0));
  // One pipe baseline serves the restart matrix and the worker-survives holds.
  const pipeRuns = restarts.reduce((sum, entry) => sum + entry.variants.length, 0) + survivePipe;
  allocate(PIPE_PROJECT, pipeRuns ? 1 + pipeRuns : 0);
  allocate(
    REVIEW_PROJECT,
    (options.review ? 1 : 0) +
      (options.reviewPastWait ? 1 : 0) +
      (surviveReview ? 1 + surviveReview : 0),
  );

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
    binFiles: (holds) => ({ pi: fakePi(holds), claude: fakeClaude(holds) }),
    ownerTag: options.ownerTag,
    reaper: options.reaper,
    ...(options.onCleanup ? { onCleanup: options.onCleanup } : {}),
    log,
  });
  const reviewer = scriptedReviewer(stack);
  const slotCounter: Record<string, number> = {};
  const modelCalls = async () =>
    (await readFile(path.join(stack.holds, 'model-calls.log'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean).length;

  async function runScenario(
    label: string,
    shapeName: ShapeName,
    phases: HoldPhase[],
  ): Promise<ScenarioResult> {
    const shape = SHAPES[shapeName];
    slotCounter[shape.project] = (slotCounter[shape.project] ?? 0) + 1;
    const slotId = `${shape.project}-${slotCounter[shape.project]}`;
    const dir = path.join(evidence, label);
    const hold: HoldContext = { slotId, slotRepo: stack.slotRepo(slotId), dir };
    // Matrix workers start once MONITOR watches them (fixtures.mts); one run at a time, so what an
    // earlier, unfinished scenario left armed or hit goes first.
    const monitoring = path.join(stack.holds, 'monitoring');
    for (const name of [
      'monitoring',
      'worker',
      'git',
      'ssh',
      'fix',
      'idle',
      'tmux',
      'tmux.arm',
      PI_TURN_FAILURE,
    ])
      for (const suffix of ['', '.hit', '.seen'])
        await rm(path.join(stack.holds, `${name}${suffix}`), { force: true });
    if (shape.scriptedReview) await reviewer.start();
    for (const phase of phases) await phase.prepare?.(hold);
    for (const phase of phases) if (phase.armAt === 'create') await phase.arm(hold);
    const armed = new Set(phases.filter((phase) => phase.armAt === 'create'));
    const restartLog: RestartRecord[] = [];
    let watched: string[] | undefined;
    let survival: string[] | undefined;
    const unreached: HoldStep[] = [];
    let current = 0;
    let runId = '';
    const getRun = async () => (await stack.call<{ run: Run }>('run.get', { runId })).run;
    const armPhase = async (phase: HoldPhase) => {
      await phase.arm(hold);
      armed.add(phase);
      await log(`${label}: ${phase.step} hold armed`);
    };
    /** The current phase's hold: its restarts once held; true when the phase is over. */
    const watchPhase = async (view: View, summary: string, changedAt: number) => {
      const phase = phases[current];
      const { run } = view;
      if (!phase) return false;
      if (!armed.has(phase) && typeof phase.armAt === 'function' && phase.armAt(view))
        await armPhase(phase);
      if (armed.has(phase) && phase.held(view)) {
        await log(`${label}: ${phase.step} held`, { run: brief(run) });
        hold.held = run;
        await writeJson(path.join(dir, `run-held-${current + 1}-${phase.step}.json`), run);
        const snapshot = phase.survive ? snapshotWorker(stack, slotId, run) : undefined;
        if (snapshot) {
          watched = [
            ...snapshot.panes.map((pane) => `pane ${pane.paneId} (pid ${pane.panePid})`),
            ...snapshot.processes.map((entry) => `pid ${entry.pid} ${entry.command.slice(0, 120)}`),
          ];
          await writeJson(path.join(dir, 'watched.json'), snapshot);
        }
        for (const [index, variant] of phase.restarts.entries()) {
          const last = index === phase.restarts.length - 1;
          const restart = await stack.restartGateway({
            ...(variant === 'node-away' ? { nodeAwayMs: phase.nodeAwayMs } : {}),
            ...(last && (phase.releaseWhileDown || phase.whileDown)
              ? {
                  whileDown: async () => {
                    if (phase.releaseWhileDown) await phase.release(hold);
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
        if (snapshot) {
          survival = phase.survive?.relaunches
            ? []
            : snapshot.processes.length
              ? await watchWorker(stack, slotId, snapshot, getRun, phase.step)
              : ['nothing to watch: no runner process at the hold point'];
          await log(`${label}: worker ${survival.length ? 'lost' : 'survived'}`, {
            watched,
            ...(survival.length ? { survival } : {}),
          });
          await phase.survive?.release?.(hold);
        }
        if (!phase.releaseWhileDown) await phase.release(hold);
        await log(`${label}: ${phase.step} released`);
        current += 1;
        return true;
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
        return true;
      }
      return false;
    };
    try {
      const driven = await driveRun({
        call: stack.call,
        log,
        label,
        dir,
        slotId,
        shape,
        hooks: {
          onCreated: (created) => {
            runId = created;
          },
          needsSlot: () => phases[current]?.needsSlot === true,
          watch: async (view, { summary, changedAt }) => {
            const { run } = view;
            if (stepStatus(run, 'monitor') === 'running' && !existsSync(monitoring))
              await writeFile(monitoring, `${runId}\n`);
            if (await watchPhase(view, summary, changedAt)) return 'again';
            // A scripted review answers each reviewer turn, except one a REVIEW hold still keeps.
            if (shape.scriptedReview && phases[current]?.step !== 'review') {
              const answered = await reviewer.answer(run, hold.slotRepo);
              if (answered) {
                await log(`${label}: scripted reviewer answered ${answered}`);
                return 'again';
              }
            }
            return undefined;
          },
          // A finalize hold arms just before the gate is resolved.
          beforeAct: async () => {
            const phase = phases[current];
            if (phase?.armAt === 'resolve' && !armed.has(phase)) await armPhase(phase);
          },
          holding: () => current < phases.length,
          pollMs: () => {
            const phase = phases[current];
            return phase && !armed.has(phase) && typeof phase.armAt === 'function' ? 100 : 500;
          },
        },
      });
      return {
        ...driven,
        label,
        restarts: restartLog,
        unreached,
        ...(watched ? { watched, survival: survival ?? [] } : {}),
        ...(hold.fixLanded !== undefined ? { fixLanded: hold.fixLanded } : {}),
        ...(shape.scriptedReview ? { reviewerTurns: reviewer.turns() } : {}),
      };
    } finally {
      if (shape.scriptedReview) await reviewer.stop(dir);
    }
  }

  /** Leaves nothing active: a later restart would otherwise recover this run too. */
  async function retireRun(runId: string) {
    const error = await retire(stack.call, runId);
    // Its outcome is already recorded; later restarts recover it too, which only adds noise.
    if (error) await log('could not retire the run', { runId, error });
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
      await retireRun(scenarioResult.runId);
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
      if (error.runId) await retireRun(error.runId);
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

  const unreachedDifferences = (result: ScenarioResult) => [
    ...result.unreached.map(
      (step) => `${step}: after the earlier restarts the run never reached this step's hold`,
    ),
    ...result.refused,
  ];

  if (options.nativeCheck) {
    // The live canary's native round trip, against this node.
    const result = await nativeCheck(stack.call, 'ri-node', options.budgetsS, 'isolated');
    onCheck(result);
    await log(`native-check ri-node: ${result.status.toUpperCase()}`, {
      seconds: result.durationS,
      differences: result.differences,
    });
  }

  if (options.lifecycle)
    onCheck(
      await check(
        { case: 'lifecycle', variant: 'ri-node', model: 'scripted' },
        () => runScenario('lifecycle', 'canary', []),
        (result) => judgeLifecycle('lifecycle', result, options.budgetsS),
      ),
    );

  if (options.f324)
    onCheck(
      await check(
        { case: 'f324-replay-open-gate', variant: '-', model: 'scripted' },
        () => runScenario('f324-replay-open-gate', 'f324', []),
        (result) => judgeLifecycle('f324-replay-open-gate', result, options.budgetsS),
      ),
    );

  // Same-night no-restart baselines, each run once when a case needs it.
  // A baseline that could not settle, or ended other than a healthy run does, makes every case
  // comparing against it unverified: a pipeline broken for every run must not compare equal.
  const baselineExpected = { pipe: LIFECYCLE_OUTCOME, 'scripted-review': REVIEWED_OUTCOME };
  const baselines: Partial<Record<'pipe' | 'scripted-review', ScenarioResult | Inconclusive>> = {};
  const baselineOf = async (shapeName: 'pipe' | 'scripted-review') => {
    if (!baselines[shapeName]) {
      try {
        const baseline = await runScenario(`baseline-${shapeName}`, shapeName, []);
        await retireRun(baseline.runId);
        await log(`baseline ${shapeName}`, {
          outcome: baseline.outcome,
          durationS: baseline.durationS,
        });
        const unhealthy = outcomeDifferences(baselineExpected[shapeName], baseline.outcome);
        if (unhealthy.length)
          throw new Inconclusive(`the baseline itself ended wrong: ${unhealthy.join('; ')}`);
        baselines[shapeName] = baseline;
      } catch (error) {
        if (!(error instanceof Inconclusive)) throw error;
        if (error.runId) await retireRun(error.runId);
        baselines[shapeName] = new Inconclusive(`no ${shapeName} baseline: ${error.message}`);
      }
    }
    const baseline = baselines[shapeName]!;
    if (baseline instanceof Inconclusive) throw baseline;
    return baseline;
  };

  if (restarts.length) {
    const baseline = await baselineOf('pipe');
    for (const { step, variants } of restarts)
      for (const variant of variants)
        onCheck(
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

  for (const step of survive) {
    const scripted = scriptedReviewStep(step);
    const pi = step === 'monitor-transport-abort';
    const claude = step.startsWith('dispatch-claude-');
    let baseline: ScenarioResult;
    const result = await check(
      {
        case: 'worker-survives',
        variant: step,
        model: scripted
          ? `scripted worker, ${REVIEWER.runner} ${REVIEWER.model} reviewer whose turns the test answers (no model call)`
          : pi
            ? 'pi worker with no model (fixture)'
            : claude
              ? 'claude worker with no model (fixture)'
              : 'scripted',
        hold: SURVIVE_HOLDS[step],
      },
      async () => {
        baseline = await baselineOf(scripted ? 'scripted-review' : 'pipe');
        return runScenario(
          `survive-${step}`,
          scripted ? 'scripted-review' : pi ? 'pi' : claude ? 'claude' : 'pipe',
          [survivePhase(stack, step, reviewer)],
        );
      },
      (scenario) => {
        const failure = failureText(scenario.run);
        const differences = [
          ...unreachedDifferences(scenario),
          ...(scenario.survival ?? ['the hold never watched the worker']),
          ...(TRANSPORT_ABORT.test(failure)
            ? [`a step failed on a dropped transport: ${failure.split('\n')[0]}`]
            : []),
          ...outcomeDifferences(baseline.outcome, scenario.outcome),
          ...(scripted ? reviewRoundDifferences(scenario, baseline) : []),
        ];
        return {
          status: differences.length ? 'fail' : 'pass',
          differences,
          observations: [
            `watched: ${(scenario.watched ?? []).join('; ') || 'nothing'}`,
            ...outcomeObservations(baseline.outcome, scenario.outcome),
            ...(scripted ? [`reviews: ${scenario.outcome.reviews.join(', ') || '-'}`] : []),
          ],
          expected: baseline.outcome,
        };
      },
    );
    if (result.modelCalls > 0) {
      result.status = 'fail';
      result.differences.push(`${result.modelCalls} model calls, expected none`);
    }
    onCheck(result);
  }

  if (options.review) {
    // One reviewed run: two model calls, four restarts; its end is derived from its verdicts.
    const model = `scripted worker, ${REVIEWER.runner} ${REVIEWER.model} reviewer`;
    let verdicts: ReturnType<typeof reviewVerdicts> | undefined;
    let procedural: string[] = [];
    let fixLanded = false;
    let retriesExhausted = false;
    const reviewCheck = await check(
      { case: 'review', variant: 'node-up', model, hold: HOLDS.review },
      () => runScenario('review', 'review', reviewPhases(stack, options.reviewFixNodeAwayMs)),
      (result) => {
        verdicts = reviewVerdicts(result.run);
        // No fix round when loop 1 passes: its holds are not reached, which is no difference.
        const expectedReviewers = verdicts.loop1 === 'pass' ? 1 : 2;
        procedural = verdicts.loop1 === 'pass' ? result.refused : unreachedDifferences(result);
        fixLanded = result.fixLanded === true;
        retriesExhausted =
          result.run.steps.find((step) => step.name === 'review')?.outputs?.maxRetriesExhausted ===
          true;
        const differences = [
          ...procedural,
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
    // Loop 2 returning issues can be the model's drift, not a restart's: that path is not modelled.
    const loop1Pass = verdicts?.loop1 === 'pass';
    const relaunched = reviewCheck.differences.some((entry) => entry.includes('re-launched'));
    const loop2Drift = reviewDriftExcuses({
      loop2: verdicts?.loop2,
      fixLanded,
      procedural,
      relaunched,
      retriesExhausted,
    });
    if (loop2Drift && reviewCheck.status === 'fail') {
      reviewCheck.status = 'not-exercised';
      reviewCheck.error = 'loop 2 returned issues (verdict drift): the restarts cannot be judged';
    }
    onCheck(reviewCheck);
    onCheck({
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

  if (options.reviewPastWait) onCheck(await reviewPastWait());

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
          if (isTerminalRunStatus(candidate.status))
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
      await retireRun(created.id);
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
}
