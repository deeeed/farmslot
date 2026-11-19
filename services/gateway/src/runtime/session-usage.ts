import { isDeepStrictEqual } from 'node:util';

import {
  type ChecklistMark,
  checklistMarks,
  mergeToolUsage,
  type ToolUsage,
} from '@farmslot/agent-runtime/tool-usage';
import type { AgentContext, Run, RunnerSessionUsage } from '@farmslot/protocol';
import {
  type PiModelCostMetadata,
  runSessionUsage,
  type SessionUsageWindow,
} from '@farmslot/slot-config';

import { loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import type { ProjectCommandEnvOptions } from '../core/project-env.js';
import { shellQuote } from '../core/tmux.js';
import {
  forcedSessionUsageArgv,
  REMOTE_USAGE_DETAIL_NOTE,
} from '../runners/native-session-usage-command.js';
import { getRunnerSessionUsageProvider } from '../runners/registry.js';
import { verifiedRunnerSessionArchivePath } from '../runners/session-archive.js';
import { checklistTimingContext, checklistTimingForAttempt } from '../tasks/checklist-timing.js';

import {
  recoveredWorkerSessionReceipt,
  registerContextSessionUsage,
  upsertSessionUsage,
} from './agent-session-rows.js';
import {
  nativeRunUsageWindow,
  resolveNativeAgentSessionUsage,
  usageLiteLlmPrices,
} from './native-session-usage.js';
import {
  parseSessionUsageOutput,
  runnerUsageMetrics,
  unavailableRunnerSessionUsage,
  usesReviewChainSessionTotal,
} from './session-usage-result.js';
export {
  parseSessionUsageOutput,
  runnerUsageMetrics,
  unavailableRunnerSessionUsage,
  usesReviewChainSessionTotal,
} from './session-usage-result.js';

const REMOTE_RECEIPT_BYTES = 64 * 1024;
/**
 * The usage command's JSON argument may grow to this with gateway prices, well inside the 128 KiB
 * a single argument may hold on Linux; above it the prices are left off.
 */
const REMOTE_USAGE_ARGUMENT_BYTES = 96 * 1024;

/**
 * The gateway's LiteLLM prices for a remote Pi receipt, or undefined to leave the slot's own
 * lookup as it was: when the gateway has no prices, when loading them fails, or when the list is
 * too large to pass in one shell argument.
 */
async function remotePiLiteLlmPrices(
  vars: SlotVars,
  slotId: string,
  commandEnvOptions: ProjectCommandEnvOptions | undefined,
): Promise<Array<[string, PiModelCostMetadata]> | undefined> {
  let prices: Array<[string, PiModelCostMetadata]>;
  try {
    prices = await usageLiteLlmPrices(vars, vars.machine, commandEnvOptions);
  } catch (error) {
    // Without the gateway's prices the receipt keeps its tokens and its previous pricing; a
    // pricing failure must not cost the run its usage totals.
    console.warn(
      `[session-usage] LiteLLM prices unavailable for ${slotId}: ${(error as Error).message}`,
    );
    return undefined;
  }
  return prices.length ? prices : undefined;
}

export async function extractRunnerSessionUsage({
  slotId,
  vars,
  runner,
  runnerSessionId,
  runnerSessionPath,
  checklistMarks,
  parentChecklistMarks,
  commandEnvOptions,
}: {
  slotId: string;
  vars?: SlotVars;
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  /** The attempt's checklist marks; tool calls, tokens and time are split at them. */
  checklistMarks?: ChecklistMark[];
  /** Parent boundaries for a remote receipt whose child breakdown exceeds the transport limit. */
  parentChecklistMarks?: ChecklistMark[];
  /** The project command env the session was launched with (a review workspace's domain). */
  commandEnvOptions?: ProjectCommandEnvOptions;
}): Promise<RunnerSessionUsage> {
  if (!runnerSessionPath) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath: null,
      error: 'runner did not expose a session transcript path',
    });
  }
  try {
    if (vars && !isLocal(vars.host, vars.machine)) {
      // Pi's LiteLLM messages are quoted from the gateway's LiteLLM price list; the slot that holds
      // the transcript may have no LiteLLM credentials, which left the receipt unpriced.
      const liteLlmPrices =
        runner === 'pi' ? await remotePiLiteLlmPrices(vars, slotId, commandEnvOptions) : undefined;
      const usageArgv = (prices?: Array<[string, PiModelCostMetadata]>) =>
        forcedSessionUsageArgv(
          slotId,
          runner,
          runnerSessionPath,
          undefined,
          checklistMarks,
          {
            maxBytes: REMOTE_RECEIPT_BYTES,
            parentChecklistMarks: isDeepStrictEqual(checklistMarks, parentChecklistMarks)
              ? undefined
              : parentChecklistMarks,
          },
          prices,
        );
      let argv = usageArgv(liteLlmPrices);
      // The JSON input is one argument; prices that would push it past the limit are left off,
      // and the slot prices the receipt as it did before.
      if (liteLlmPrices && Buffer.byteLength(argv[argv.length - 2]) > REMOTE_USAGE_ARGUMENT_BYTES) {
        console.warn(
          `[session-usage] gateway LiteLLM prices omitted for ${slotId}: usage argument too large`,
        );
        argv = usageArgv();
      }
      const result = await execOnSlot(vars, argv.map(shellQuote).join(' '), {
        timeout: 30_000,
        maxBuffer: REMOTE_RECEIPT_BYTES,
        selectNodeSupport: false,
      });
      if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || `Usage extraction exited ${result.exitCode}`);
      return parseSessionUsageOutput(result.stdout, { runner, runnerSessionId, runnerSessionPath });
    }
    const output = await runSessionUsage({
      // repo is unused when forcedPath is set; pass empty string.
      repo: '',
      slotId,
      action: 'total',
      forcedPath: runnerSessionPath,
      forcedRunner: runner ?? null,
      environment: { ...process.env, ...vars?.machineEnv },
      checklistMarks,
    });
    return parseSessionUsageOutput(output, {
      runner: runner ?? null,
      runnerSessionId: runnerSessionId ?? null,
      runnerSessionPath,
    });
  } catch (err) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath,
      error: (err as Error).message,
    });
  }
}

async function archivedSessionUsage(
  run: Run,
  archived: string,
  session: Pick<RunnerSessionUsage, 'runnerSessionId' | 'runnerSessionPath'> = {},
  vars?: SlotVars,
  usageWindow?: SessionUsageWindow,
  marks?: ChecklistMark[],
): Promise<RunnerSessionUsage> {
  return parseSessionUsageOutput(
    await runSessionUsage({
      repo: '',
      slotId: run.slotId ?? run.id,
      action: 'total',
      forcedPath: archived,
      forcedRunner: run.metrics.runner,
      environment: { ...process.env, ...vars?.machineEnv },
      usageWindow,
      checklistMarks: marks,
    }),
    { runner: run.metrics.runner, ...session },
  );
}

/** The worker checklist's marks from this context's attempt onward (the worker's by default). */
export function contextChecklistMarks(
  run: Run,
  context: AgentContext | undefined = checklistTimingContext(run, 'CHECKLIST.md'),
): ChecklistMark[] {
  return checklistMarks(
    checklistTimingForAttempt(
      run.metrics.checklistTiming,
      context?.attemptStartedAt ?? context?.startedAt,
    ),
  );
}

/** Bounds child row expansion independently of the serialized remote receipt limit. */
export const RECEIPT_CHILD_MARK_LIMIT = 100;
export const RECEIPT_CHILD_TITLE_CHARS = 80;
export const RECEIPT_CHILD_TITLE_BYTES = 240;

function childTitle(id: string, row: number, label: string): string {
  // The mark writer keeps a numbered row's own number in its label.
  const title = `${id} ${/^\d+[.)] /.test(label) ? label : `${row}. ${label}`}`;
  // Cut on character boundaries, so an emoji is never split in half, and to a byte budget, so 100
  // titles of multi-byte emoji stay small in the usage command's argument and its receipt.
  const characters = [...new Intl.Segmenter().segment(title)].map((part) => part.segment);
  if (
    characters.length <= RECEIPT_CHILD_TITLE_CHARS &&
    Buffer.byteLength(title) <= RECEIPT_CHILD_TITLE_BYTES
  )
    return title;
  let kept = '';
  for (const character of characters.slice(0, RECEIPT_CHILD_TITLE_CHARS - 1)) {
    if (Buffer.byteLength(kept + character + '…') > RECEIPT_CHILD_TITLE_BYTES) break;
    kept += character;
  }
  return `${kept}…`;
}

/**
 * The marks a measured session is split at: the worker checklist's marks, plus the row marks of
 * each child checklist that a parent step ran (`metrics.subtasks`), so that parent step splits by
 * the child's rows. A child row's segment carries its parent's step number and a
 * `<child> <row>. <label>` title. Live progress keeps the parent marks only.
 */
export function receiptChecklistMarks(
  run: Run,
  context: AgentContext | undefined = checklistTimingContext(run, 'CHECKLIST.md'),
  /** Transcripts measured for this context: a relaunched worker leaves more than one. */
  sessionsInContext = 1,
): ChecklistMark[] {
  const parents = contextChecklistMarks(run, context);
  // Each transcript of a relaunched context gets these marks, and an earlier transcript's calls
  // fall before this attempt's first mark: they stay on the parent step, not on one rule.
  if (sessionsInContext > 1) return parents;
  const startedAt = context?.attemptStartedAt ?? context?.startedAt;
  const source = run.metrics.checklistTiming?.source ?? 'CHECKLIST.md';
  const children = (run.metrics.subtasks ?? []).flatMap((child) =>
    child.parent.checklist === source
      ? checklistMarks(checklistTimingForAttempt(child.checklistTiming, startedAt)).map((mark) => ({
          ...mark,
          stepNumber: child.parent.stepNumber,
          label: childTitle(child.id, mark.stepNumber, mark.label),
        }))
      : [],
  );
  if (children.length > RECEIPT_CHILD_MARK_LIMIT) return parents;
  // One boundary per step and instant: of rows marked in the same millisecond, or a last row and
  // the parent step it closes (`mark sub <id> complete --mark-last`), the child's last row stays.
  const byInstant = new Map<string, ChecklistMark>();
  for (const mark of [...parents, ...children])
    byInstant.set(`${mark.stepNumber}\u0000${mark.checkedAt}`, mark);
  // At one instant an earlier step closes before a later step's row.
  return [...byInstant.values()].sort(
    (a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt) || a.stepNumber - b.stepNumber,
  );
}

export function remoteReceiptDetailLimited(usage: RunnerSessionUsage): boolean {
  return usage.captureGaps?.includes(REMOTE_USAGE_DETAIL_NOTE) ?? false;
}

/** Sums the sessions' tool usage only when every session reported it. */
function totalToolUsage(usages: RunnerSessionUsage[]): ToolUsage | null {
  const counted = usages.map((usage) => usage.toolUsage);
  if (!counted.every((usage) => usage !== undefined)) return null;
  const combined = mergeToolUsage(counted);
  if (
    combined &&
    usages.some((usage) => remoteReceiptDetailLimited(usage) && !usage.toolUsage?.steps.length)
  )
    return {
      ...combined,
      steps: [],
      toolCallsBeforeFirstMark: null,
      stepsUnavailable: REMOTE_USAGE_DETAIL_NOTE,
    };
  return combined;
}

/** Completion and family reads share the same worker-only multi-session accounting. */
export async function extractRunWorkerSessionUsage(
  run: Run,
  vars?: SlotVars,
  record?: (
    session: import('../runners/session-usage-provider.js').RecoveredUsageSession,
    usage: RunnerSessionUsage,
  ) => void,
): Promise<RunnerSessionUsage | null> {
  const slotId = run.slotId;
  if (!slotId || usesReviewChainSessionTotal(run)) return null;
  const provider = getRunnerSessionUsageProvider(run.metrics.runner);
  const sessions = await provider?.recoverSessions?.(run);
  if (!sessions?.length) return null;
  const unique = [
    ...new Map(sessions.map((session) => [session.runnerSessionPath, session])).values(),
  ];
  const slotVars = vars ?? (await loadSlotVars(slotId));
  const usages = await Promise.all(
    unique.map(async (session) => {
      const context = run.agentContexts?.find((row) => row.id === session.contextId);
      const receipt = run.sessionUsage?.find(
        (row) =>
          row.runner === run.metrics.runner && row.runnerSessionId === session.runnerSessionId,
      );
      const nativeSession = receipt?.nativeSession ?? context?.nativeSession;
      const marks = receiptChecklistMarks(
        run,
        context,
        unique.filter((other) => other.contextId === session.contextId).length,
      );
      let usageWindow: SessionUsageWindow | undefined;
      if (nativeSession) {
        try {
          usageWindow = nativeRunUsageWindow(run, {
            runner: run.metrics.runner,
            runnerSessionId: session.runnerSessionId,
            startedAt:
              receipt?.startedAt ?? context?.nativeSession?.launchRequestedAt ?? context?.startedAt,
            completedAt: run.completedAt,
          });
        } catch (error) {
          // A missing boundary is local to this conversation. Retain sibling receipts.
          return unavailableRunnerSessionUsage({
            runner: run.metrics.runner,
            ...session,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const input = {
        slotId,
        vars: slotVars,
        runner: run.metrics.runner,
        ...session,
        checklistMarks: marks,
        parentChecklistMarks: contextChecklistMarks(run, context),
      };
      let usage: RunnerSessionUsage;
      if (nativeSession) {
        const resolved = await resolveNativeAgentSessionUsage({
          ...input,
          runner: run.metrics.runner ?? '',
          nativeSession,
          usageWindow,
        });
        usage = resolved.usage;
        usageWindow = resolved.usageWindow;
        // No archive can safely attribute native usage without node-owned boundaries.
        if (!usageWindow) return usage;
      } else {
        usage = await extractRunnerSessionUsage(input);
      }
      if (!usage.error) return usage;
      try {
        const archived = await provider?.recoverArchive?.(run, session);
        if (!archived) return usage;
        const recovered = await archivedSessionUsage(
          run,
          archived,
          session,
          slotVars,
          usageWindow,
          marks,
        );
        return { ...recovered, scope: usageWindow ? 'run-delta' : recovered.scope };
      } catch (error) {
        // Failed archive verification/accounting must not discard successful siblings.
        return unavailableRunnerSessionUsage({
          runner: run.metrics.runner,
          ...session,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  usages.forEach((usage, index) => record?.(unique[index], usage));
  const failed = usages.find((usage) => usage.error || usage.totalTokens == null);
  if (failed)
    return unavailableRunnerSessionUsage({
      runner: run.metrics.runner,
      error: failed.error ?? 'Worker session usage is unavailable',
    });
  const total = (field: keyof RunnerSessionUsage): number | null => {
    const values = usages.map((usage) => usage[field]);
    return values.every((value) => typeof value === 'number')
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const cost = total('costUsd');
  const toolUsage = totalToolUsage(usages);
  return {
    ...usages[0],
    toolUsage: toolUsage ?? undefined,
    toolUsageError: toolUsage
      ? undefined
      : usages.find((usage) => usage.toolUsageError)?.toolUsageError,
    turns: total('turns'),
    inputTokens: total('inputTokens'),
    outputTokens: total('outputTokens'),
    cacheCreation: total('cacheCreation'),
    cacheRead: total('cacheRead'),
    totalTokens: total('totalTokens'),
    costUsd: cost == null ? null : Number(cost.toFixed(10)),
    costStatus: cost == null ? 'unpriced' : 'estimated',
    costReason:
      cost == null ? usages.find((usage) => usage.costUsd == null)?.costReason : undefined,
  };
}

/** Recover only verified retained native usage, without rewriting stored runs. */
export async function projectArchivedRunnerUsage(storedRun: Run): Promise<Run> {
  let run = storedRun;
  try {
    let workerUsage: RunnerSessionUsage | null;
    try {
      workerUsage = await extractRunWorkerSessionUsage(run, undefined, (session, usage) => {
        const rows = registerContextSessionUsage(run, run.updatedAt) ?? [];
        run = {
          ...run,
          sessionUsage: upsertSessionUsage(
            rows,
            recoveredWorkerSessionReceipt(run, session, usage),
          ),
        };
      });
    } catch (error) {
      // A recycled/offline slot cannot replace known totals or a verified archive.
      workerUsage = unavailableRunnerSessionUsage({
        runner: run.metrics.runner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (workerUsage && !workerUsage.error)
      return {
        ...run,
        metrics: {
          ...run.metrics,
          ...runnerUsageMetrics(workerUsage),
          costEstimate: workerUsage.costUsd ?? undefined,
          sessionUsageError: workerUsage.error,
        },
      };
    if (run.metrics.sessionTotalTokens != null && run.metrics.sessionTurns != null)
      return workerUsage?.error
        ? { ...run, metrics: { ...run.metrics, sessionUsageError: workerUsage.error } }
        : run;
    if (
      run.transport === 'native' ||
      run.agentContexts?.some(
        (context) => context.nativeSession || context.nativeSessionHistory?.length,
      ) ||
      run.sessionUsage?.some((receipt) => receipt.nativeSession || receipt.usageLeaseIds?.length)
    ) {
      return {
        ...run,
        metrics: {
          ...run.metrics,
          sessionUsageError:
            workerUsage?.error ?? 'Native run usage requires a resolved task boundary',
        },
      };
    }
    const archived = await verifiedRunnerSessionArchivePath(run);
    if (!archived) {
      const reason =
        workerUsage?.error ??
        run.metrics.sessionUsageError ??
        run.metrics.runnerSessionArchive?.reason ??
        'runner did not report usage and no verified transcript was retained';
      return { ...run, metrics: { ...run.metrics, sessionUsageError: reason } };
    }
    const usage = await archivedSessionUsage(
      run,
      archived,
      {},
      undefined,
      undefined,
      receiptChecklistMarks(run),
    );
    // A resumed review transcript is a chain total, not this generation's usage.
    if (usesReviewChainSessionTotal(run)) return run;
    return {
      ...run,
      metrics: {
        ...runnerUsageMetrics(usage),
        ...run.metrics,
        sessionUsageError: workerUsage?.error ?? usage.error,
      },
    };
  } catch (error) {
    return { ...run, metrics: { ...run.metrics, sessionUsageError: (error as Error).message } };
  }
}

export { extractNativeAgentSessionUsage } from './native-session-usage.js';
