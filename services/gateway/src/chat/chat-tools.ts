// chat/chat-tools.ts — Fleet tool executor and read-only tool filtering

import path from 'node:path';

import { failedRunCancelEffects, type FlowType, parseGitHubRef } from '@farmslot/protocol';

import { farmslotRoot, getCachedFleet } from '../fleet/state.js';
import { decisionList } from '../methods/decisions.js';
import { operatorSnapshot, runContextBundle, runRecoveryProposal } from '../methods/operator.js';
import { terminalSend } from '../methods/terminal.js';
import { getRun, listRuns } from '../runs/store.js';

import { normalizeSessionId } from './chat-store.js';
import {
  listFarmslotLogsTool,
  readFarmslotFileTool,
  readTaskFileTool,
  searchFarmslotFilesTool,
} from './self-inspection-tools.js';
import { FLEET_TOOLS } from './tool-definitions.js';

const FLOW_TYPES = [
  'fix-bug',
  'review-pr',
  'dev',
  'pr-complete',
  'update-branch',
] as const satisfies readonly FlowType[];
const INVESTIGATOR_MAX_QUESTION_CHARS = 4_000;
export const INVESTIGATOR_MAX_TOOL_ROUNDS = 6;

export interface ExecuteToolOptions {
  sessionId?: string;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  options: ExecuteToolOptions = {},
): Promise<{ toolCallId: string; toolName: string; content: string; isError: boolean }> {
  try {
    let result: unknown;
    // Lazy-load broadcastEvent to avoid circular import (server→chat→chat-tools→server)
    const broadcast = async () => (await import('../server.js')).broadcastEvent;

    switch (name) {
      // ─── Read tools: fleet state ───
      case 'list_active_runs': {
        const { runs } = listRuns({ active: true, limit: 20 });
        result = runs.map((r) => ({
          id: r.id.slice(0, 8),
          flow: r.flowType,
          status: r.status,
          slot: r.slotId,
          ticket: r.ticketOrPr,
          pendingDecisions: r.decisions?.filter((d) => !d.resolvedAt).length ?? 0,
        }));
        break;
      }
      case 'get_run': {
        const id = String(args.run_id ?? '');
        const run = getRun(id) ?? listRuns({ limit: 200 }).runs.find((r) => r.id.startsWith(id));
        result = run ?? { error: 'Run not found' };
        break;
      }
      case 'run_context_bundle': {
        result = await runContextBundle({ runId: String(args.run_id ?? '') });
        break;
      }
      case 'propose_run_recovery': {
        const { proposal } = await runRecoveryProposal({
          runId: String(args.run_id ?? ''),
          stepName: typeof args.step_name === 'string' ? args.step_name : undefined,
        });
        result = proposal;
        break;
      }
      case 'get_slot': {
        const fleet = getCachedFleet();
        result = fleet?.slots.find((s) => s.slot === args.slot_id) ?? { error: 'Slot not found' };
        break;
      }
      case 'fleet_refresh': {
        const { fleetRefresh } = await import('../methods/fleet.js');
        const { fleet } = await fleetRefresh();
        result = { slots: fleet.slots.length, summary: fleet.summary };
        break;
      }
      case 'list_pending_decisions': {
        const { decisions } = await decisionList();
        result = {
          source: 'decision.list',
          checkedAt: new Date().toISOString(),
          count: decisions.length,
          decisions: decisions.map((d) => ({
            runId: d.context?.runId ? String(d.context.runId).slice(0, 8) : null,
            ticket: d.context?.ticketOrPr ?? d.runMeta?.ticketOrPr ?? null,
            slot: d.slotId ?? null,
            decisionId: d.id,
            type: d.type,
            title: d.title,
            actions: d.actions.map((a) => `${a.id} (${a.label})`),
          })),
        };
        break;
      }
      case 'operator_snapshot': {
        result = await operatorSnapshot();
        break;
      }
      case 'chat_session_context': {
        const { chatSessionContext } = await import('../methods/chat.js');
        result = chatSessionContext({
          sessionId: typeof args.session_id === 'string' ? args.session_id : options.sessionId,
        });
        break;
      }
      case 'read_last_screen_evidence': {
        const { readLastScreenEvidence } = await import('./screen-evidence.js');
        result = readLastScreenEvidence(
          normalizeSessionId(
            typeof args.session_id === 'string' ? args.session_id : options.sessionId,
          ),
        );
        break;
      }
      case 'read_observer_evidence': {
        const { readObserverEvidence } = await import('./copilot-observer.js');
        result = readObserverEvidence({
          severity:
            args.severity === 'info' || args.severity === 'warn' || args.severity === 'error'
              ? args.severity
              : undefined,
          type: typeof args.type === 'string' ? args.type : undefined,
          runId: typeof args.run_id === 'string' ? args.run_id : undefined,
          slotId: typeof args.slot_id === 'string' ? args.slot_id : undefined,
          windowMs: typeof args.window_ms === 'number' ? args.window_ms : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        break;
      }
      case 'queue_list': {
        const { listItems } = await import('../backlog/dispatch-queue.js');
        result = listItems();
        break;
      }
      case 'get_machine_health': {
        const { getMachineHealth, getAllMachineHealth } = await import('../fleet/node-health.js');
        const machine = args.machine as string | undefined;
        if (machine) {
          const health = getMachineHealth(machine);
          result = health ?? { error: `No health data for machine: ${machine}` };
        } else {
          result = getAllMachineHealth();
        }
        break;
      }
      case 'read_farmslot_file': {
        result = await readFarmslotFileTool(args);
        break;
      }
      case 'search_farmslot_files': {
        result = await searchFarmslotFilesTool(args);
        break;
      }
      case 'list_farmslot_logs': {
        result = await listFarmslotLogsTool();
        break;
      }
      case 'investigate_gateway_issue': {
        result = await investigateGatewayIssue(args);
        break;
      }

      // ─── Read tools: run history ───
      case 'search_runs': {
        const flowType = parseFlowType(args.flow_type);
        const { runs } = listRuns({
          search: args.query as string | undefined,
          ...(flowType ? { flowType } : {}),
          outcome: args.outcome as string | undefined,
          limit: (args.limit as number | undefined) ?? 20,
        });
        result = runs.map((r) => ({
          id: r.id.slice(0, 8),
          flow: r.flowType,
          status: r.status,
          ticket: r.ticketOrPr,
          branch: r.branch,
          outcome: r.metrics.outcome ?? null,
          error: r.error ?? null,
          summary: r.summary ?? null,
          taskRelDir: r.taskFile ? path.dirname(r.taskFile).replace(farmslotRoot + '/', '') : null,
          createdAt: r.createdAt,
        }));
        break;
      }
      case 'read_task_file': {
        result = await readTaskFileTool(args);
        break;
      }
      case 'check_pr': {
        const prRef = String(args.pr_ref ?? '');
        // Shared parser rather than a local lastIndexOf split, which mis-handled
        // refs like `foo/bar/baz#123` and silently produced an undefined repo.
        const parsedRef = parseGitHubRef(prRef);
        if (!parsedRef) {
          // Previously fell back to a placeholder `example-org/example-mobile`, so a
          // bare `123` queried a repo that does not exist and surfaced an opaque gh
          // error. Name the real problem instead: the ref carries no repo.
          throw new Error(
            `check_pr needs an owner/repo-qualified PR ref (e.g. owner/repo#123), got: ${prRef || '(empty)'}`,
          );
        }
        const repoSlug = parsedRef.repo;
        const number = String(parsedRef.number);
        const { ghRequest } = await import('../integrations/github-client.js');
        const pr = await ghRequest([
          'pr',
          'view',
          String(number),
          '--repo',
          repoSlug,
          '--json',
          'state,title,url,mergeable,headRefName,reviews',
        ]);
        const prData = JSON.parse(pr.stdout);
        result = {
          state: prData.state,
          title: prData.title,
          url: prData.url,
          mergeable: prData.mergeable,
          branch: prData.headRefName,
          reviewStates: (prData.reviews as Array<{ state: string; author: { login: string } }>).map(
            (r: { state: string; author: { login: string } }) => ({
              author: r.author.login,
              state: r.state,
            }),
          ),
        };
        break;
      }
      case 'list_pull_requests': {
        const { prList } = await import('../methods/pr.js');
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 50));
        const project =
          typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined;
        const { prs } = await prList(project ? { project } : {});
        const priority: Record<string, number> = {
          NEEDS_ATTENTION: 0,
          READY: 1,
          IN_REVIEW: 2,
          WORKING: 3,
          WAITING_FOR_MERGE: 4,
          MERGED: 5,
          CLOSED_WITHOUT_MERGE: 6,
        };
        const sorted = [...prs].sort(
          (a, b) =>
            (priority[a.recommendation] ?? 99) - (priority[b.recommendation] ?? 99) ||
            b.checkSummary.failed - a.checkSummary.failed ||
            b.actionableBotComments.length - a.actionableBotComments.length ||
            b.pr - a.pr,
        );
        const buckets: Record<string, number> = {};
        for (const pr of prs) buckets[pr.recommendation] = (buckets[pr.recommendation] ?? 0) + 1;
        result = {
          total: prs.length,
          buckets,
          prs: sorted.slice(0, limit).map((pr) => ({
            pr: pr.pr,
            repo: pr.repo,
            title: pr.title,
            project: pr.project,
            recommendation: pr.recommendation,
            reviewDecision: pr.reviewDecision,
            checks: pr.checkSummary,
            failedNames: pr.failedNames.slice(0, 8),
            actionableBotComments: pr.actionableBotComments.length,
            slot: pr.slot,
            familyId: pr.familyId ?? null,
            latestRunId: pr.latestRunId ?? null,
            workflowState: pr.workflowState ?? null,
            mergeState: pr.mergeState ?? null,
          })),
        };
        break;
      }

      // ─── Read tools: workspace inspection ───
      case 'read_file': {
        const { fsRead } = await import('../methods/filesystem.js');
        const { content, language } = await fsRead({
          slotId: String(args.slot_id),
          path: String(args.path),
        });
        result = { language, content };
        break;
      }
      case 'list_files': {
        const { fsList } = await import('../methods/filesystem.js');
        const { entries } = await fsList({ slotId: String(args.slot_id), path: String(args.path) });
        result = entries;
        break;
      }
      case 'git_status': {
        const { gitStatus } = await import('../methods/git.js');
        result = await gitStatus({ slotId: String(args.slot_id) });
        break;
      }
      case 'git_diff': {
        const { gitDiff } = await import('../methods/git.js');
        const { diff } = await gitDiff({
          slotId: String(args.slot_id),
          base: args.base as string | undefined,
          path: args.path as string | undefined,
        });
        result = diff;
        break;
      }
      case 'git_log': {
        const { gitLog } = await import('../methods/git.js');
        result = await gitLog({
          slotId: String(args.slot_id),
          limit: args.limit as number | undefined,
        });
        break;
      }
      case 'terminal_snapshot': {
        const { terminalSnapshot } = await import('../methods/terminal.js');
        const snap = await terminalSnapshot({
          slotId: String(args.slot_id),
          lines: args.lines as number | undefined,
        });
        result = snap.lines.join('\n');
        break;
      }
      case 'task_progress': {
        const { taskProgress } = await import('../methods/task.js');
        const progress = await taskProgress({ slotId: String(args.slot_id) });
        result = {
          markdown: progress.markdown,
          ...(progress.structured
            ? {
                currentPhase: progress.structured.currentPhase,
                currentStep: progress.structured.currentStep,
                completedSteps: progress.structured.completedSteps,
                totalSteps: progress.structured.totalSteps,
              }
            : {}),
        };
        break;
      }
      case 'search_code': {
        const { searchQuery } = await import('../methods/search.js');
        const { matches, truncated } = await searchQuery({
          slotId: String(args.slot_id),
          pattern: String(args.pattern),
          fileGlob: args.file_glob as string | undefined,
          maxResults: (args.max_results as number | undefined) ?? 50,
        });
        result = { matches, truncated };
        break;
      }

      // ─── Tmux control ───
      case 'tmux_list': {
        const { tmuxList } = await import('../methods/tmux-control.js');
        result = await tmuxList({ slotId: String(args.slot_id) });
        break;
      }
      case 'tmux_send_keys': {
        const { tmuxSendKeys } = await import('../methods/tmux-control.js');
        await tmuxSendKeys({ slotId: String(args.slot_id), keys: String(args.keys) });
        result = { sent: true };
        break;
      }
      case 'tmux_select_window': {
        const { tmuxSelectWindow } = await import('../methods/tmux-control.js');
        await tmuxSelectWindow({ slotId: String(args.slot_id), index: Number(args.index) });
        result = { selected: true };
        break;
      }

      // ─── Resource management ───
      case 'resource_list': {
        const { resourceList } = await import('../methods/resource.js');
        const fleet = getCachedFleet();
        const slotId = args.slot_id as string | undefined;
        const machine = args.machine as string | undefined;
        if (slotId) {
          const { resources } = await resourceList({ slotId });
          result = resources.map((r) => ({
            slot: slotId,
            resource: r.id,
            label: r.definition.label,
            type: r.definition.type,
            status: r.status,
          }));
        } else {
          const slotIds =
            fleet?.slots.filter((s) => !machine || s.machine === machine).map((s) => s.slot) ?? [];
          const all: Array<{
            slot: string;
            resource: string;
            label: string;
            type: string;
            status: string;
          }> = [];
          await Promise.all(
            slotIds.map(async (sid) => {
              const { resources } = await resourceList({ slotId: sid });
              for (const r of resources) {
                all.push({
                  slot: sid,
                  resource: r.id,
                  label: r.definition.label,
                  type: r.definition.type,
                  status: r.status,
                });
              }
            }),
          );
          result = all;
        }
        break;
      }
      case 'resource_control': {
        const { executeResourceControl } = await import('../fleet/resource-manager.js');
        result = await executeResourceControl(
          String(args.slot_id),
          String(args.resource_id),
          String(args.action) as 'boot' | 'shutdown' | 'relaunch',
        );
        break;
      }
      case 'resource_pressure_snapshot': {
        const { resourcePressureSnapshot } = await import('../methods/resource.js');
        result = await resourcePressureSnapshot({
          ...(typeof args.machine === 'string' ? { machine: args.machine } : {}),
          ...(typeof args.project === 'string' ? { project: args.project } : {}),
        });
        break;
      }
      case 'resource_refresh': {
        const { pollSlotResources } = await import('../fleet/resource-manager.js');
        const fleetState = getCachedFleet();
        const refreshSlotId = args.slot_id as string | undefined;
        const refreshMachine = args.machine as string | undefined;
        if (refreshSlotId) {
          const statuses = await pollSlotResources(refreshSlotId);
          result = { slotId: refreshSlotId, resources: statuses };
        } else {
          const slotIds =
            fleetState?.slots
              .filter((s) => !refreshMachine || s.machine === refreshMachine)
              .map((s) => s.slot) ?? [];
          const all: Array<{ slotId: string; resources: Array<{ id: string; status: string }> }> =
            [];
          await Promise.all(
            slotIds.map(async (sid) => {
              const statuses = await pollSlotResources(sid);
              if (statuses.length > 0) {
                all.push({ slotId: sid, resources: statuses });
              }
            }),
          );
          result = all;
        }
        break;
      }

      // ─── Write tools ───
      case 'send_terminal': {
        await terminalSend({ slotId: String(args.slot_id), text: String(args.text), enter: true });
        result = { sent: true };
        break;
      }
      case 'cancel_run': {
        const { runCancel } = await import('../methods/run/lifecycle-control.js');
        // No emitter: the transition broadcasts globally itself (ADR-053).
        const id = String(args.run_id ?? '');
        const run = getRun(id) ?? listRuns({ limit: 200 }).runs.find((r) => r.id.startsWith(id));
        if (!run) throw new Error(`Run not found: ${id}`);
        const { run: cancelled, effects } = await runCancel({
          runId: run.id,
          reason: String(args.reason ?? 'Cancelled via co-pilot'),
        });
        // The run reaching `cancelled` is not the whole story: an advisory effect can
        // fail, leaving a slot claimed or the backlog unsettled. Reporting only
        // `cancelled: true` would tell the operator the stop fully landed.
        const failed = failedRunCancelEffects(effects);
        result = {
          cancelled: true,
          runId: cancelled.id.slice(0, 8),
          status: cancelled.status,
          ...(failed.length
            ? {
                partiallyApplied: true,
                failedEffects: failed.map((effect) => `${effect.name}: ${effect.detail ?? 'failed'}`),
              }
            : {}),
        };
        break;
      }
      case 'resolve_decision': {
        const { runResolveDecision } = await import('../methods/run.js');
        const emit = await broadcast();
        const runId = String(args.run_id ?? '');
        const run =
          getRun(runId) ?? listRuns({ limit: 200 }).runs.find((r) => r.id.startsWith(runId));
        if (!run) throw new Error(`Run not found: ${runId}`);
        const { run: updated } = await runResolveDecision(
          { runId: run.id, decisionId: String(args.decision_id), actionId: String(args.action_id) },
          emit,
        );
        result = { resolved: true, runId: updated.id.slice(0, 8), status: updated.status };
        break;
      }
      case 'slot_prepare': {
        const { slotPrepare } = await import('../methods/slot.js');
        const emit = await broadcast();
        const { prepared } = await slotPrepare(
          {
            slotId: String(args.slot_id),
            branch: args.branch as string | undefined,
            mergeMain: args.merge_main as boolean | undefined,
          },
          emit,
        );
        result = { prepared, slotId: args.slot_id };
        break;
      }
      case 'slot_release': {
        const { slotRelease } = await import('../methods/slot.js');
        const emit = await broadcast();
        const { released } = await slotRelease({ slotId: String(args.slot_id) }, emit);
        result = { released, slotId: args.slot_id };
        break;
      }
      case 'slot_recycle': {
        const { slotRecycle } = await import('../methods/slot.js');
        const emit = await broadcast();
        const { released } = await slotRecycle({ slotId: String(args.slot_id) }, emit);
        result = { recycled: released, slotId: args.slot_id };
        break;
      }
      case 'queue_add': {
        const { addItem } = await import('../backlog/dispatch-queue.js');
        const flowType = parseFlowType(args.flow_type);
        if (!flowType) throw new Error(`Invalid flow_type: ${String(args.flow_type ?? '')}`);
        const item = addItem({
          flowType,
          project: String(args.project),
          ticketOrPr: String(args.ticket_or_pr),
          slotId: args.slot_id as string | undefined,
          model: args.model as string | undefined,
          runner: args.runner as string | undefined,
          priority: 10,
        });
        result = { queued: true, itemId: item.id.slice(0, 8) };
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      toolCallId: callId,
      toolName: name,
      content: JSON.stringify(result, null, 2),
      isError: false,
    };
  } catch (err) {
    return { toolCallId: callId, toolName: name, content: (err as Error).message, isError: true };
  }
}

export const DIAGNOSTIC_READ_ONLY_TOOL_NAMES = new Set([
  'list_active_runs',
  'get_run',
  'run_context_bundle',
  'propose_run_recovery',
  'get_slot',
  'list_pending_decisions',
  'operator_snapshot',
  'chat_session_context',
  'read_last_screen_evidence',
  'read_observer_evidence',
  'queue_list',
  'get_machine_health',
  'read_farmslot_file',
  'search_farmslot_files',
  'list_farmslot_logs',
  'investigate_gateway_issue',
  'search_runs',
  'read_task_file',
  'check_pr',
  'list_pull_requests',
  'read_file',
  'list_files',
  'git_status',
  'git_diff',
  'git_log',
  'terminal_snapshot',
  'task_progress',
  'search_code',
  'tmux_list',
  'resource_list',
  'resource_pressure_snapshot',
]);

const READ_ONLY_INVESTIGATION_TOOL_NAMES = new Set(
  [...DIAGNOSTIC_READ_ONLY_TOOL_NAMES].filter((name) => name !== 'investigate_gateway_issue'),
);

export const INVESTIGATION_TOOLS = FLEET_TOOLS.filter((tool) =>
  READ_ONLY_INVESTIGATION_TOOL_NAMES.has(tool.name),
);

export const DIAGNOSTIC_READ_ONLY_TOOLS = FLEET_TOOLS.filter((tool) =>
  DIAGNOSTIC_READ_ONLY_TOOL_NAMES.has(tool.name),
);

export const GENERAL_COPILOT_READ_ONLY_TOOL_NAMES = new Set(DIAGNOSTIC_READ_ONLY_TOOL_NAMES);
export const GENERAL_COPILOT_READ_ONLY_TOOLS = FLEET_TOOLS.filter((tool) =>
  GENERAL_COPILOT_READ_ONLY_TOOL_NAMES.has(tool.name),
);

export async function executeDiagnosticReadOnlyTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  options: ExecuteToolOptions = {},
) {
  if (!DIAGNOSTIC_READ_ONLY_TOOL_NAMES.has(name)) {
    return {
      toolCallId: callId,
      toolName: name,
      content: `Tool ${name} is not available in diagnostic-readonly chat mode.`,
      isError: true,
    };
  }
  return executeTool(name, args, callId, options);
}

export async function executeGeneralReadOnlyTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  options: ExecuteToolOptions = {},
) {
  if (!GENERAL_COPILOT_READ_ONLY_TOOL_NAMES.has(name)) {
    return {
      toolCallId: callId,
      toolName: name,
      content: `Tool ${name} is not available in general Co-Pilot chat mode. Side effects must be proposed as confirmed action cards.`,
      isError: true,
    };
  }
  return executeTool(name, args, callId, options);
}

async function investigateGatewayIssue(args: Record<string, unknown>) {
  const question = String(args.question ?? '').trim();
  if (!question) throw new Error('question is required');
  if (question.length > INVESTIGATOR_MAX_QUESTION_CHARS) {
    throw new Error(
      `question is too long (${question.length} chars, max ${INVESTIGATOR_MAX_QUESTION_CHARS})`,
    );
  }

  const runId = args.run_id ? String(args.run_id).trim() : '';
  const focus = args.focus ? String(args.focus).trim() : '';
  const { callLLMChat, describeModel } = await import('../llm/index.js');
  const { getLLMConfig } = await import('../llm/config.js');
  const { buildFleetContext } = await import('./chat-context.js');
  const cfg = getLLMConfig();
  const provider = cfg.defaultProvider;
  const model = cfg.intelligenceModel;
  const runtimeIdentity = describeModel(provider, model);
  const fleetContext = await buildFleetContext();

  const systemPrompt = `You are a bounded read-only gateway investigation worker.

Runtime: ${runtimeIdentity}

Rules:
- Use tools before answering whenever the question is about live runs, decisions, queue state, source code, logs, or UI/backend mismatch.
- You may only use the read-only tools provided to you. Do not request write tools or operational actions.
- Keep the report concise and evidence-first.
- If data is missing or a tool returns an error, report that limitation directly.
- Mark anything inferred as "Inference".

Output format:
Finding: <one-sentence answer>
Evidence: <tool names and key counts/IDs/paths>
Details: <short bullets or compact paragraph>
Next: <specific operator or code follow-up, or "none">`;

  const userPrompt = [
    `Question: ${question}`,
    runId ? `Run ID seed: ${runId}` : '',
    focus ? `Focus: ${focus}` : '',
    `Current fleet context:\n${fleetContext}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await callLLMChat({
    provider,
    model,
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 1800,
    tools: INVESTIGATION_TOOLS,
    maxToolRounds: INVESTIGATOR_MAX_TOOL_ROUNDS,
    toolExecutor: executeReadOnlyInvestigationTool,
  });

  return {
    worker: {
      kind: 'gateway-readonly-investigator',
      runtime: runtimeIdentity,
      maxToolRounds: INVESTIGATOR_MAX_TOOL_ROUNDS,
    },
    question,
    ...(runId ? { runId } : {}),
    ...(focus ? { focus } : {}),
    report: result.text.trim(),
    usage: result.usage,
  };
}

export async function executeReadOnlyInvestigationTool(
  name: string,
  args: Record<string, unknown>,
  callId: string,
) {
  if (!READ_ONLY_INVESTIGATION_TOOL_NAMES.has(name)) {
    return {
      toolCallId: callId,
      toolName: name,
      content: `Tool ${name} is not available to read-only gateway investigation workers.`,
      isError: true,
    };
  }
  return executeTool(name, args, callId);
}

function parseFlowType(value: unknown): FlowType | undefined {
  if (typeof value !== 'string') return undefined;
  return FLOW_TYPES.find((flowType) => flowType === value);
}
