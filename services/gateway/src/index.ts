// index.ts — Gateway daemon entry point
// Starts HTTP + WebSocket server on port 7777

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import { dirname, resolve } from 'node:path';

import { type EvalTrialStartParams, Events, primaryRoleForFlow } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import {
  initAutoRecovery,
  routeEventToAutoRecovery,
  scanFailedRunsForAutoRecovery,
} from './auto-recovery/watcher.js';
import { initAutoRecycle } from './automation/auto-recycle.js';
import { onBranchChange, startBranchWatchers } from './automation/branch-watcher.js';
import { initDispatchQueue, loadQueue } from './backlog/dispatch-queue.js';
import {
  initBacklogStore,
  loadBacklog,
  markBacklogRunObserved,
  markBacklogRunReleased,
  markBacklogRunStarted,
} from './backlog/store.js';
import { checkDailyAutosave, ensureCopilotDirs } from './chat/chat-memory.js';
import { getAllSessions, initChatStore } from './chat/chat-store.js';
import { initCopilotObserver, routeEventToObserver } from './chat/copilot-observer.js';
import { initCIMonitor } from './ci-monitor/service.js';
import { loadGatewayTlsMaterial } from './core/gateway-tls.js';
import { getGatewayListenSnapshot, setGatewayListenAddress } from './core/listen-address.js';
import { loadEvalSuiteCaps } from './evals/suite-cap-store.js';
import { getMachineHealth, startLocalCollection } from './fleet/node-health.js';
import {
  farmslotRoot,
  getCachedFleet,
  loadFleetStatus,
  setBranchOverlay,
  setTaskProgressOverlay,
  startFileWatcher,
  statusFile,
} from './fleet/state.js';
import { loadBindingsCache } from './integrations/github-bindings-cache.js';
import { initGitHubClient } from './integrations/github-client.js';
import { initPrLinkage } from './integrations/pr-linkage.js';
import {
  initImprovementEngine,
  recoverStaleImprovementPlaceholders,
} from './intelligence/improvement-engine.js';
import { refreshBranches } from './methods/dispatch.js';
import { isFreeSlot } from './methods/dispatch/slot-scoring.js';
import { serveFile, serveRunArtifact } from './methods/filesystem.js';
import { fleetRefresh } from './methods/fleet.js';
import { reconcileStalePrepareLocks } from './methods/slot.js';
import { serveStaticUi } from './methods/static-ui.js';
import { startMonitor } from './observability/fleet-monitor.js';
import { initRunCompletion } from './run-completion/orchestrator.js';
import {
  initRunEngine,
  recoverActiveRuns,
  startOrphanReconciler,
} from './run-engine/orchestrator.js';
import { initRunMonitor } from './run-engine/run-monitor.js';
import { loadAllRuns } from './runs/store.js';
import {
  assertGatewayBindAllowed,
  authorizeHttpRequest,
  createGatewayAuthRuntime,
} from './security/auth.js';
import { applyGatewayCors } from './security/origin.js';
import { initSelfReview } from './self-review/orchestrator.js';
import { onTaskProgress, onWorkerSignal, startWatchingActiveSlots } from './tasks/watcher.js';
import { applyRunningWorkerSignalToContext } from './tasks/worker-signal-context.js';
import { initWorkGraphStore, loadWorkGraphs, schedulerTick } from './work-graph/store.js';
import { broadcast, broadcastEvent, createWebSocketServer, initServerGlobals } from './server.js';
import { handleGitHubWebhook, handleJiraWebhook } from './webhook.js';

const PORT = Number(process.env.GATEWAY_PORT) || 7777;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH means stale lock; EPERM still means a live process owns the PID.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireGatewaySingletonLock(): () => void {
  const lockPath = resolve(farmslotRoot, '.runs', `gateway-${PORT}.pid`);
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${process.pid}\n`, 'utf-8');
      return () => {
        if (!existsSync(lockPath)) return;
        const lockedPid = Number(readFileSync(lockPath, 'utf-8').trim());
        if (lockedPid === process.pid) unlinkSync(lockPath);
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      let existingPid = NaN;
      try {
        existingPid = Number(readFileSync(lockPath, 'utf-8').trim());
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
        if (processIsAlive(existingPid)) {
          throw new Error(
            `Gateway already running for ${farmslotRoot} on port ${PORT} (pid ${existingPid}). ` +
              `Stop the stale gateway before starting another instance to avoid split-brain run state.`,
          );
        }
      }
      // Existing lock is stale or malformed. Remove it and retry the atomic create;
      // if another process wins the race, the next openSync('wx') sees EEXIST.
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}
const ENABLE_BRANCH_WATCHERS =
  process.env.FARMSLOT_BRANCH_WATCHERS === '1' || process.env.FARMSLOT_BRANCH_WATCHERS === 'true';
const ENABLE_LOCAL_HEALTH_POLL =
  process.env.FARMSLOT_LOCAL_HEALTH_POLL === '1' ||
  process.env.FARMSLOT_LOCAL_HEALTH_POLL === 'true';
const STARTUP_BRANCH_PREWARM =
  process.env.FARMSLOT_STARTUP_BRANCH_PREWARM === '1' ||
  process.env.FARMSLOT_STARTUP_BRANCH_PREWARM === 'true';
// Control-plane orchestration (run recovery, auto-recovery, prepare-lock reconcile,
// orphan reconciler). MUST stay off for per-worktree validation/recipe stacks: those
// share the operator's FARMSLOT_RUNS_DIR, so if they orchestrate they recover the
// operator's in-flight runs and re-drive prepare — whose pre-launch sweep kills the
// operator's live prepare-* tmux window (deterministic prepare failure on fresh boot).
// Only the operator/primary gateway orchestrates; sandbox-dev.sh sets the disable flag.
const ENABLE_ORCHESTRATION = process.env.FARMSLOT_DISABLE_ORCHESTRATION !== '1';

async function main(): Promise<void> {
  const releaseGatewaySingletonLock = acquireGatewaySingletonLock();
  process.once('exit', releaseGatewaySingletonLock);
  process.once('SIGINT', () => {
    releaseGatewaySingletonLock();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    releaseGatewaySingletonLock();
    process.exit(143);
  });

  // Load env files from farmslot root — force-override existing env vars
  // (Node --env-file won't override, causing stale values after tsx watch reload).
  // .env.local-auth holds FARMSLOT_GATEWAY_TOKEN; without it the gateway falls
  // back to auth=none and binds to 127.0.0.1, breaking remote node connections.
  for (const name of ['.env', '.env.local-auth']) {
    const envPath = resolve(farmslotRoot, name);
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
      console.log(`[env] loaded ${envPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.warn(
          `[env] ${envPath} not found — should be configured (see ${name}.sample if available)`,
        );
      } else {
        console.warn(`[env] failed to load ${envPath}: ${(err as Error).message}`);
      }
    }
  }

  const gatewayAuthRuntime = createGatewayAuthRuntime();
  const host =
    process.env.GATEWAY_HOST?.trim() ||
    (gatewayAuthRuntime.auth.mode === 'none' ? '127.0.0.1' : undefined);
  assertGatewayBindAllowed({ auth: gatewayAuthRuntime.auth, host, port: PORT });
  setGatewayListenAddress(host, PORT);
  console.log(`[auth] gateway mode=${gatewayAuthRuntime.auth.mode}`);

  // Co-pilot observer — wraps broadcastEvent so the observer sees every event
  // without modifying any individual handler
  const originalBroadcast = broadcastEvent;
  const observedBroadcast = (event: string, payload: unknown): void => {
    originalBroadcast(event, payload);
    routeEventToObserver(event, payload);
    routeEventToAutoRecovery(event, payload);
    if (event === Events.RUN_UPDATED || event === Events.RUN_COMPLETED) {
      const run = (payload as { run?: import('@farmslot/protocol').Run }).run;
      if (run) {
        markBacklogRunObserved(run);
        if (run.workGraphId) {
          schedulerTick({ graphId: run.workGraphId }).catch((err) => {
            console.error(
              `[work-graph] run event reconciliation failed for ${run.workGraphId}: ${(err as Error).message}`,
            );
          });
        }
      }
    }
    if (event === Events.RUN_DELETED) {
      const runId = (payload as { runId?: string }).runId;
      if (runId) {
        markBacklogRunReleased(runId)
          .then((graphIds) => {
            for (const graphId of graphIds) {
              schedulerTick({ graphId }).catch((err) => {
                console.error(
                  `[work-graph] run delete reconciliation failed for ${graphId}: ${(err as Error).message}`,
                );
              });
            }
          })
          .catch((err) => {
            console.error(
              `[backlog] failed to release deleted run ${runId}: ${(err as Error).message}`,
            );
          });
      }
    }
  };

  // GitHub client — unified `gh` router with ETag/304, rate-limit broadcasts,
  // and disk-backed branch→PR bindings. Initialized before any subsystem that
  // may fire a gh call during startup (run-engine recovery, pr-linkage, etc.).
  initGitHubClient(observedBroadcast);
  loadBindingsCache();

  // Load initial fleet state
  const missingFile = !existsSync(statusFile);
  await loadFleetStatus();
  const cached = getCachedFleet();
  // Re-bootstrap when the file is missing OR the cache is empty (read failed or file was corrupt).
  const needsBootstrap = missingFile || !cached || cached.slots.length === 0;

  // Restore active runs from .runs/ + init engine + monitor
  await loadAllRuns();
  initRunEngine(observedBroadcast);
  initRunMonitor(observedBroadcast);
  initRunCompletion(observedBroadcast);
  initImprovementEngine(observedBroadcast);
  initPrLinkage(observedBroadcast);
  initCIMonitor(observedBroadcast);
  initAutoRecycle(observedBroadcast);
  initAutoRecovery(observedBroadcast);

  // Co-pilot: store + workspace bootstrap + observer
  initChatStore();
  await ensureCopilotDirs();
  initCopilotObserver(observedBroadcast);
  const { getLLMConfig } = await import('./llm/config.js');
  const llmCfg = getLLMConfig();
  console.log(
    `[chat] LLM provider: ${llmCfg.defaultProvider}, copilot: ${llmCfg.copilotModel}, intelligence: ${llmCfg.intelligenceModel} (config: ${resolve(farmslotHome(), 'llm-config.json')})`,
  );
  console.log(
    `[chat-actions] direct-issue=${process.env.COPILOT_PROPOSED_ACTIONS_DIRECT_ISSUE === '0' ? 'disabled' : 'enabled'}`,
  );

  // Daily auto-save: every 24h, summarize sessions that haven't been saved
  setInterval(
    () => {
      const sessions = getAllSessions().map((s) => ({
        id: s.id,
        messages: s.messages,
        lastSavedAt: s.lastSavedAt,
      }));
      checkDailyAutosave(sessions, broadcastEvent).catch((err) => {
        console.error(`[chat] daily auto-save error: ${(err as Error).message}`);
      });
    },
    24 * 60 * 60 * 1000,
  );
  initSelfReview(observedBroadcast);

  // Load dispatch queue + init auto-dispatch
  await loadEvalSuiteCaps();
  await loadQueue();
  initBacklogStore(observedBroadcast);
  await loadBacklog();
  initWorkGraphStore(observedBroadcast);
  await loadWorkGraphs();
  schedulerTick().catch((err) => {
    console.error(`[work-graph] startup reconciliation failed: ${(err as Error).message}`);
  });

  initDispatchQueue(observedBroadcast, async (item) => {
    if (item.queueKind === 'eval-cell' && item.evalCell) {
      const { evalTrialStart } = await import('./methods/eval.js');
      const params = item.evalCell.trialStartParams as unknown as EvalTrialStartParams;
      const result = await evalTrialStart(
        {
          ...params,
          project: item.project,
          experimentManifestPath: item.evalCell.experimentManifestPath,
          trialId: item.evalCell.trialId,
          capGroupId: item.evalCell.capGroupId,
          suiteId: item.evalCell.suiteId,
          slotId: item.slotId,
          allowedSlots:
            item.allowedSlots && item.allowedSlots.length > 0 ? item.allowedSlots : undefined,
        },
        observedBroadcast,
      );
      item.runId = result.run?.id;
      return;
    }
    const { runCreate } = await import('./methods/run.js');
    const runParams = {
      flowType: item.flowType,
      project: item.project,
      ticketOrPr: item.ticketOrPr,
      familyId: item.familyId,
      parentRunId: item.parentRunId ?? undefined,
      familyRootTicketOrPr: item.familyRootTicketOrPr,
      lane: item.lane,
      variant: item.variant ?? undefined,
      taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
      app: item.app,
      prepareProfile: item.prepareProfile,
      slotId: item.slotId,
      allowedSlots:
        item.allowedSlots && item.allowedSlots.length > 0 ? item.allowedSlots : undefined,
      branch: item.branch ?? undefined,
      completionPolicy: item.completionPolicy,
      startRef: item.startRef?.requestedRef,
      startRefSource: item.startRef?.source,
      model: item.model,
      runner: item.runner,
      scripted: item.scripted,
      effort: item.effort,
      mode: item.mode,
      devInteractiveProfile: item.devInteractiveProfile,
      tags: item.tags,
      initialContext: item.initialContext,
      ticketData: item.ticketData,
      backlogItemId: item.backlogItemId,
      workGraphId: item.workGraphId,
      workNodeId: item.workNodeId,
      launchPlanId: item.launchPlanId,
      launchCandidateId: item.launchCandidateId,
      launchGroupId: item.launchGroupId,
      launchSlotPolicy: item.launchSlotPolicy,
      devChecklist: item.devChecklist,
      reviewDepth: item.reviewDepth,
      pendingReviewPlan: item.pendingReviewPlan,
    } satisfies import('@farmslot/protocol').RunCreateParams;
    const { run } = await runCreate(runParams, broadcastEvent);
    item.runId = run.id;
    try {
      await markBacklogRunStarted(item, run);
    } catch (err) {
      // The run is already durable at this point. Re-throwing would make the
      // queue retry and create a duplicate run for the same backlog item, so
      // surface the linkage error while treating queue handoff as complete.
      console.error(`[backlog] failed to link started run: ${(err as Error).message}`);
    }
  });

  // Shared request handler for the plaintext HTTP server and (when TLS is
  // configured) the HTTPS server — identical health/file/artifact/webhook/
  // static-UI routing regardless of transport.
  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!applyGatewayCors(req, res)) {
      res.writeHead(403);
      res.end('Forbidden origin');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/health') {
      const listen = getGatewayListenSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          ...(listen ? { listen } : {}),
        }),
      );
      return;
    }
    // Serve raw files: /api/file?slotId=X&path=Y
    if (req.url?.startsWith('/api/file?')) {
      if (!authorizeHttpRequest({ runtime: gatewayAuthRuntime, req, res })) return;
      serveFile(req, res);
      return;
    }
    // Serve run artifacts: /api/run-artifact?runId=X&path=Y (relative to task artifacts dir)
    if (req.url?.startsWith('/api/run-artifact?')) {
      if (!authorizeHttpRequest({ runtime: gatewayAuthRuntime, req, res })) return;
      serveRunArtifact(req, res);
      return;
    }
    // Webhook endpoints
    if (req.method === 'POST' && req.url === '/webhook/github') {
      handleGitHubWebhook(req, res).catch((err) => {
        console.error(`[webhook/github] error: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/webhook/jira') {
      handleJiraWebhook(req, res).catch((err) => {
        console.error(`[webhook/jira] error: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      });
      return;
    }
    // Fall through: serve the built Command Center UI bundle for GET, else 404.
    if (req.method === 'GET' && serveStaticUi(req, res)) return;
    res.writeHead(404);
    res.end();
  };

  // Create HTTP server (health check endpoint) + attach WebSocket server.
  const httpServer = createServer(requestHandler);
  createWebSocketServer(httpServer, gatewayAuthRuntime);

  // Register process-global side effects ONCE — not per server. The optional TLS
  // listener below calls createWebSocketServer a second time, so any duplicate
  // registration there would double every fleet/PTY broadcast and auto-dispatch tick.
  initServerGlobals();

  // Start watching .farm-status.json for changes
  startFileWatcher();

  // Local host polling shells out for disk/thermal/memory details. Keep it opt-in
  // because node agents already push metrics and gateway startup should be cheap.
  if (ENABLE_LOCAL_HEALTH_POLL) {
    const localMachine = os.hostname().replace(/\.local$/, '');
    startLocalCollection(localMachine, 30_000, (machine) => {
      broadcastEvent(Events.NODE_HEALTH_UPDATED, { machine, health: getMachineHealth(machine) });
    });
    console.log(`[node-health] local collection started for "${localMachine}" (30s interval)`);
  } else {
    console.log('[node-health] local collection disabled (set FARMSLOT_LOCAL_HEALTH_POLL=1)');
  }

  // Start server-side monitoring
  startMonitor({
    onFleetUpdated(fleet) {
      broadcast({
        type: 'event',
        event: Events.FLEET_UPDATED,
        payload: { fleet },
      });
    },
    onDecisionNew(decision) {
      broadcast({
        type: 'event',
        event: Events.DECISION_NEW,
        payload: { decision },
      });
    },
    onViolation(violation) {
      broadcast({
        type: 'event',
        event: Events.MONITOR_VIOLATION,
        payload: { violation },
      });
      routeEventToObserver(Events.MONITOR_VIOLATION, { violation });
      routeEventToAutoRecovery(Events.MONITOR_VIOLATION, { violation });
    },
  });

  // Start watching TASK.md + SIGNAL.json for active working slots
  onTaskProgress((slotId, progress, role, contextId, runId) => {
    // Keep fleet.status taskPhase/taskStepProgress tied to the primary slot worker.
    // Role panes publish their own progress via TASK_PROGRESS_UPDATED.
    const slot = getCachedFleet()?.slots.find((candidate) => candidate.slot === slotId);
    const flowPrimaryRole = primaryRoleForFlow(slot?.currentFlowType);
    if (
      progress.structured &&
      runId === slot?.currentRunId &&
      (!contextId || role === 'primary' || role === flowPrimaryRole)
    ) {
      setTaskProgressOverlay(
        slotId,
        progress.structured.currentPhase,
        progress.structured.completedSteps,
        progress.structured.totalSteps,
      );
    }
    broadcast({
      type: 'event',
      event: Events.TASK_PROGRESS_UPDATED,
      payload: { slotId, runId, role, contextId, progress },
    });
  });
  onWorkerSignal((slotId, runId, signal, role, contextId) => {
    void applyRunningWorkerSignalToContext(slotId, runId, signal, role, contextId).catch(
      (error) => {
        console.warn(
          `[worker-signal] failed to apply running signal for ${slotId}: ${(error as Error).message}`,
        );
      },
    );
    broadcast({
      type: 'event',
      event: Events.WORKER_SIGNAL,
      payload: { slotId, runId, role, contextId, signal },
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  console.log(`Gateway daemon listening on ws://${host ?? '0.0.0.0'}:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  // Optional TLS listener: when a cert+key are configured, serve wss:// (and
  // https health) on a second port so a hosted HTTPS Command Center can reach
  // this local gateway (Chrome 150 blocks ws:// from https origins as mixed
  // content; wss:// is not blocked). No cert configured → ws:// only, unchanged.
  // Best-effort: a TLS misconfiguration must not take down the control plane, so
  // it degrades to ws:// with a teaching log rather than crashing the gateway.
  try {
    const tls = loadGatewayTlsMaterial();
    if (tls) {
      const httpsServer = createHttpsServer({ cert: tls.cert, key: tls.key }, requestHandler);
      createWebSocketServer(httpsServer, gatewayAuthRuntime);
      await new Promise<void>((resolveTls, reject) => {
        httpsServer.once('error', reject);
        httpsServer.listen(tls.port, host, () => {
          httpsServer.off('error', reject);
          resolveTls();
        });
      });
      console.log(`Gateway TLS listening on wss://${host ?? '0.0.0.0'}:${tls.port}`);
      console.log(`Health check (TLS): https://localhost:${tls.port}/health`);
    } else {
      console.log(
        '[tls] disabled (set FARMSLOT_GATEWAY_TLS_CERT/KEY or run `farmslot certs setup`)',
      );
    }
  } catch (err) {
    console.error(
      `[tls] not started — serving ws:// only. ${(err as Error).message} ` +
        'Fix the TLS config (or run `farmslot certs setup`) and restart the gateway.',
    );
  }

  // Recover active runs after the port is open so slow recovery cannot make the
  // UI's Vite proxy see ECONNREFUSED while the gateway is still booting.
  if (ENABLE_ORCHESTRATION) {
    recoverActiveRuns()
      .then(() => scanFailedRunsForAutoRecovery())
      .catch((err) => {
        console.error(`[run-engine] recovery error: ${(err as Error).message}`);
      });
  } else {
    console.log(
      '[run-engine] orchestration disabled (validation stack; FARMSLOT_DISABLE_ORCHESTRATION=1)',
    );
  }
  // Sweep stuck "analyzing" improvement placeholders — gateway crash mid-LLM
  // would otherwise leave the inbox card spinning forever. Synchronous so we
  // don't race the first post-recovery decision broadcast.
  try {
    recoverStaleImprovementPlaceholders();
  } catch (err) {
    console.error(`[improvement] placeholder recovery error: ${(err as Error).message}`);
  }
  if (ENABLE_ORCHESTRATION) {
    reconcileStalePrepareLocks().catch((err) => {
      console.error(`[slot.prepare] startup reconcile error: ${(err as Error).message}`);
    });
    startOrphanReconciler();
  }

  // Bootstrap fleet from pool configs if file is missing or cache is empty.
  if (needsBootstrap) {
    const reason = missingFile ? 'no .farm-status.json' : 'cached fleet is empty';
    console.log(`[startup] ${reason} — running initial fleet refresh`);
    fleetRefresh()
      .then(({ fleet }) => {
        broadcastEvent(Events.FLEET_UPDATED, { fleet });
      })
      .catch((err) => {
        console.error(`[startup] fleet refresh failed: ${(err as Error).message}`);
      });
  }

  // Start watching TASK.md + SIGNAL.json after bind. These are live-data
  // enrichments; they must not block the gateway health endpoint or websocket.
  startWatchingActiveSlots().catch((err) => {
    console.error(`[task-watcher] startup failed: ${(err as Error).message}`);
  });

  if (ENABLE_BRANCH_WATCHERS) {
    // Start watching .git/HEAD for all enabled slots (branch change detection)
    // after bind because some slot git probes can be slow or unavailable.
    onBranchChange(async (slotId, branch) => {
      setBranchOverlay(slotId, branch);
      const fleet = await loadFleetStatus(true);
      broadcastEvent(Events.FLEET_UPDATED, { fleet });
    });
    startBranchWatchers().catch((err) => {
      console.error(`[branch-watcher] startup failed: ${(err as Error).message}`);
    });
  } else {
    console.log('[branch-watcher] disabled (set FARMSLOT_BRANCH_WATCHERS=1)');
  }

  // Optional branch-cache pre-warm. Keep this off by default so starting a gateway
  // is a cheap server operation; dispatch.candidates refreshes branches on demand.
  if (STARTUP_BRANCH_PREWARM) {
    (async () => {
      try {
        const fleet = await loadFleetStatus();
        const freeSlots = fleet.slots.filter(isFreeSlot);
        if (freeSlots.length === 0) return;
        console.log(`[startup] pre-warming branch cache for ${freeSlots.length} free slot(s)`);
        await refreshBranches(freeSlots);
        console.log(`[startup] branch cache warm`);
      } catch (err) {
        // Pre-warm is best-effort — swallow into console.error so a misconfigured
        // pool slot or transient SSH glitch doesn't block startup. PoolConfigError
        // (and other refresh errors) will surface to the operator on the first
        // dispatch.candidates call since refreshBranches re-throws there.
        console.error(`[startup] branch pre-warm failed: ${(err as Error).message}`);
      }
    })();
  } else {
    console.log('[startup] branch cache pre-warm disabled (set FARMSLOT_STARTUP_BRANCH_PREWARM=1)');
  }
}

main().catch((err) => {
  console.error('Gateway failed to start:', err);
  process.exit(1);
});
