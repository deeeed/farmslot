import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import os from 'node:os';

import type { NativeSessionClient } from '@farmslot/agent-runtime/native';
import {
  type CopilotConfigureParams,
  type CopilotConfigureResult,
  type CopilotDelivery,
  type CopilotRuntimeSession,
  type CopilotStartParams,
  type CopilotStartResult,
  type CopilotStatusResult,
  type CopilotStopParams,
  type CopilotStopResult,
  type CopilotWorkloadSnapshot,
  Events,
  type NativeCommandObservation,
  type NativeSessionInfo,
  type NativeSessionRequester,
} from '@farmslot/protocol';

import { getActiveResources } from '../fleet/resource-manager.js';
import { getCachedFleet } from '../fleet/state.js';
import { onNativeSessionChange } from '../resources/native-session-changes.js';
import { resourceRevisions } from '../resources/revisions.js';
import { workspaceObservations, workspaceSourceId } from '../resources/workspace-observations.js';
import { nativeSessionManager } from '../runners/native/manager.js';
import { getAllRuns } from '../runs/store.js';
import { requireGenerationZeroOwner } from '../security/native-node.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import {
  assertDangerousConfirmation,
  COPILOT_DANGEROUS_TYPED_PHRASE,
  dangerousLaunchBinding,
} from './authorization.js';
import { buildLiveCopilotBootstrapBrief } from './bootstrap-brief.js';
import {
  COPILOT_TMUX_SESSION,
  type CopilotTmuxAdapter,
  localCopilotTmuxAdapter,
  resolveCopilotRunner,
  resolveOperatorCheckout,
} from './launcher.js';
import { inspectCopilotCheckout } from './live-fix-policy.js';
import { buildCopilotWorkloadSnapshot, type WorkloadResourceInput } from './resource-policy.js';
import {
  type CopilotAuditRecord,
  CopilotRuntimeStore,
  type PersistedCopilotRuntime,
} from './session-store.js';

type Emit = (event: string, payload: unknown) => void;
type CopilotNative = Pick<
  NativeSessionClient,
  'ensure' | 'inspect' | 'commandStatus' | 'send' | 'close'
>;
const RECONCILE_MS = 5_000;
function dangerousAutostartEnabled(): boolean {
  return process.env.FARMSLOT_COPILOT_DANGEROUS_AUTOSTART === COPILOT_DANGEROUS_TYPED_PHRASE;
}
function configuredOwner(): string {
  const owner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID?.trim();
  if (!owner) throw new Error('Configure the gateway native owner before starting the Co-Pilot');
  requireGenerationZeroOwner(owner);
  return owner;
}
export interface CopilotRuntimeControllerOptions {
  store?: CopilotRuntimeStore;
  /** Legacy detection and explicit stop only. Never launches or reads a TUI. */
  tmux?: Pick<CopilotTmuxAdapter, 'listCandidates' | 'kill'>;
  native?: CopilotNative;
  owner?: () => string;
  checkout?: string;
  emit?: Emit;
  now?: () => Date;
  inspectCheckout?: typeof inspectCopilotCheckout;
  observeCheckout?: (checkout: string) => Promise<() => Promise<void>>;
  buildBootstrap?: typeof buildLiveCopilotBootstrapBrief;
  workload?: (copilotRunning: boolean) => CopilotWorkloadSnapshot;
  observeNative?: (owner: string, changed: () => void) => () => void;
}

/** Singleton launch policy only. The native host is the sole conversation writer. */
export class CopilotRuntimeController {
  private readonly store: CopilotRuntimeStore;
  private readonly tmux: Pick<CopilotTmuxAdapter, 'listCandidates' | 'kill'>;
  private readonly native: CopilotNative;
  private readonly owner: () => string;
  private readonly checkout: string;
  private readonly emit: Emit;
  private readonly now: () => Date;
  private readonly inspectCheckout: typeof inspectCopilotCheckout;
  private readonly observeCheckout: NonNullable<CopilotRuntimeControllerOptions['observeCheckout']>;
  private readonly buildBootstrap: typeof buildLiveCopilotBootstrapBrief;
  private readonly workloadOverride?: CopilotRuntimeControllerOptions['workload'];
  private persisted: PersistedCopilotRuntime | null = null;
  private committed?: CopilotRuntimeSession;
  private readonly observeNative: NonNullable<CopilotRuntimeControllerOptions['observeNative']>;
  private stopNative?: () => void;
  private watchedOwner?: string;
  private reconciling?: Promise<void>;
  private reconcileAgain = false;
  private backgroundFailure?: Error;
  private disposed = false;
  private initialized = false;
  private initializing?: Promise<void>;
  private publishedSession?: string;
  private startPromise?: Promise<CopilotStartResult>;
  private checkedAt = -Infinity;
  private legacyOwned = false;
  private legacyCandidates: string[] = [];

  constructor(options: CopilotRuntimeControllerOptions = {}) {
    this.store = options.store ?? new CopilotRuntimeStore();
    this.tmux = options.tmux ?? localCopilotTmuxAdapter;
    this.native = options.native ?? nativeSessionManager;
    this.owner = options.owner ?? configuredOwner;
    this.checkout = options.checkout ?? resolveOperatorCheckout();
    this.emit = options.emit ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.inspectCheckout = options.inspectCheckout ?? inspectCopilotCheckout;
    this.observeCheckout =
      options.observeCheckout ??
      (async (checkout) => {
        const root = await realpath(checkout);
        return workspaceObservations.capture({
          root,
          sourceId: workspaceSourceId('local', root),
          keys: [{ family: 'copilot', ownerId: 'gateway-copilot' }],
          current: async () => this.checkout === checkout && (await realpath(checkout)) === root,
        });
      });
    this.buildBootstrap = options.buildBootstrap ?? buildLiveCopilotBootstrapBrief;
    this.workloadOverride = options.workload;
    this.observeNative =
      options.observeNative ?? ((owner, changed) => onNativeSessionChange('local', owner, changed));
  }
  currentSession(): CopilotRuntimeSession | null {
    return this.committed ?? null;
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    return (this.initializing ??= this.initializeOnce().finally(() => {
      this.initializing = undefined;
    }));
  }
  private async initializeOnce(): Promise<void> {
    await this.store.ensure();
    this.persisted = await this.store.load();
    this.committed = this.persisted ? structuredClone(this.persisted.session) : undefined;
    if (this.persisted?.nativeOwnerPrincipalId && this.persisted.session.nativeSession)
      this.watchNative(this.persisted.nativeOwnerPrincipalId);
    this.legacyOwned = Boolean(
      this.persisted &&
      !this.persisted.session.nativeSession &&
      ['starting', 'running', 'reconnecting'].includes(this.persisted.session.status),
    );
    await this.reconcile();
    this.initialized = true;
    if (
      this.persisted?.session.autostart &&
      !this.legacyCandidates.length &&
      ['stopped', 'failed'].includes(this.persisted.session.status)
    ) {
      // This preserves an explicitly configured policy. Reading a page never sets autostart.
      void this.startWithPolicy({}, dangerousAutostartEnabled()).catch((error) =>
        this.backgroundFailed(error),
      );
    }
  }
  async status(): Promise<CopilotStatusResult> {
    await this.initialize();
    if (this.backgroundFailure) {
      if (this.persisted) {
        this.persisted.session.status = 'failed';
        this.persisted.session.terminalReason = this.backgroundFailure.message;
        await this.persist();
        this.emitRuntime();
      }
      this.backgroundFailure = undefined;
    }
    await this.reconcile();
    const confirm = await this.observeCheckout(this.checkout);
    const checkout = await this.inspectCheckout(this.checkout);
    if (!this.persisted) {
      const { runner, model, effort } = resolveCopilotRunner();
      const now = this.timestamp();
      this.persisted = {
        schemaVersion: 1,
        session: {
          runtimeId: 'gateway-copilot',
          status: this.legacyCandidates.length ? 'ambiguous' : 'stopped',
          runner,
          model,
          effort,
          autostart: dangerousAutostartEnabled(),
          safetyTier: dangerousAutostartEnabled() ? 'dangerous' : 'sandboxed',
          checkout,
          workload: this.workload(false),
          lastDelivery: this.idleDelivery(now),
          updatedAt: now,
          terminalReason: this.legacyCandidates.length ? this.legacyReason() : 'not-started',
          dangerousLaunch: dangerousLaunchBinding({ checkout, runner, model, effort }),
        },
      };
    } else {
      const session = this.persisted.session;
      const previous = session.checkout;
      session.checkout = checkout;
      session.workload = this.workload(session.status === 'running');
      if (session.status === 'stopped' && session.effort === undefined)
        session.effort = resolveCopilotRunner({
          runner: session.runner,
          model: session.model,
        }).effort;
      session.dangerousLaunch = dangerousLaunchBinding({
        checkout,
        runner: session.runner,
        model: session.model,
        effort: session.effort,
      });
      session.updatedAt = this.timestamp();
      if (previous.head !== checkout.head || previous.branch !== checkout.branch)
        await this.audit('checkout-transition', {
          from: { branch: previous.branch, head: previous.head },
          to: { branch: checkout.branch, head: checkout.head },
        });
    }
    await this.persist();
    await confirm();
    return { session: this.persisted.session };
  }
  async configure(
    params: CopilotConfigureParams,
    authorize: () => void = () => {},
  ): Promise<CopilotConfigureResult> {
    const { session } = await this.status();
    const requestedRunner = params.runner ?? session.runner;
    const { runner, model, effort } = resolveCopilotRunner({
      runner: requestedRunner,
      model: params.model ?? (requestedRunner === session.runner ? session.model : undefined),
      effort: params.effort ?? (requestedRunner === session.runner ? session.effort : undefined),
    });
    authorize();
    if (
      (['starting', 'running', 'reconnecting', 'stopping'].includes(session.status) ||
        (session.nativeSession &&
          this.persisted?.stoppedNativeSessionId !== session.nativeSession.sessionId)) &&
      (runner !== session.runner || model !== session.model || effort !== session.effort)
    )
      throw new Error('Stop the Co-Pilot runtime before changing its runner, model or effort');
    Object.assign(session, {
      runner,
      model,
      effort,
      autostart: params.autostart ?? session.autostart,
      dangerousLaunch: dangerousLaunchBinding({
        checkout: session.checkout,
        runner,
        model,
        effort,
      }),
      updatedAt: this.timestamp(),
    });
    await this.persist();
    await this.audit('configure', { runner, model, effort, autostart: session.autostart });
    this.emitRuntime();
    return { session };
  }
  start(
    params: CopilotStartParams = {},
    authorize: () => void = () => {},
  ): Promise<CopilotStartResult> {
    if (this.disposed) throw new Error('Co-Pilot controller is closed');
    authorize();
    return this.startWithPolicy(params, false, authorize);
  }
  private startWithPolicy(
    params: CopilotStartParams,
    localAutostart: boolean,
    authorize: () => void = () => {},
  ): Promise<CopilotStartResult> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce(params, localAutostart, authorize)
      .catch(async (error) => {
        if (this.disposed) throw error;
        if (this.persisted?.session.status === 'starting') {
          this.persisted.session.status = 'failed';
          this.persisted.session.terminalReason = `launch failed: ${(error as Error).message}`;
          await this.persist();
          this.emitRuntime();
        }
        throw error;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }
  private async startOnce(
    params: CopilotStartParams,
    localAutostart: boolean,
    authorize: () => void,
  ): Promise<CopilotStartResult> {
    const { session } = await this.status();
    this.legacyCandidates = await this.tmux.listCandidates(COPILOT_TMUX_SESSION);
    if (this.legacyCandidates.length) throw new Error(this.legacyReason());
    const owner = this.owner();
    let continuation: NativeSessionInfo | undefined;
    if (session.status === 'stopping') throw new Error('Wait for the original Co-Pilot to stop');
    if (session.nativeSession) {
      const id = session.nativeSession.sessionId;
      const stopped = this.persisted!.stoppedNativeSessionId === id;
      if (this.persisted!.nativeOwnerPrincipalId !== owner && !stopped)
        throw new Error('Stop the original-owner Co-Pilot before changing its native owner');
      if (
        stopped &&
        (await this.retiredNativeResumed(this.persisted!.nativeOwnerPrincipalId ?? owner, id))
      ) {
        session.status = 'failed';
        session.terminalReason = this.resumedReason();
        await this.persist();
        this.emitRuntime();
        throw new Error(session.terminalReason);
      }
      if (!stopped) {
        let observed: NativeCommandObservation | undefined;
        try {
          observed = await this.native.commandStatus(owner, id, `copilot-bootstrap:${id}`);
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 'NOT_FOUND'
          )
            throw error;
        }
        if (observed) {
          this.assertNative(observed.session, owner, id);
          if (['closed', 'failed'].includes(observed.session.state)) {
            if (observed.session.processPid && !observed.session.processStopped)
              throw new Error('Stop the original native process before starting another Co-Pilot');
            this.persisted!.stoppedNativeSessionId = id;
            delete this.persisted!.pendingNativeSessionId;
            session.status = 'stopped';
            await this.persist();
          } else if (observed.receipt) {
            authorize();
            observed = observed.receipt.accepted
              ? observed
              : await this.native.commandStatus(owner, id, `copilot-bootstrap:${id}`, true);
            this.applyCommandObservation(observed);
            await this.persist();
            this.emitRuntime();
            if (session.status !== 'running')
              throw new Error(
                'Co-Pilot bootstrap acceptance is unconfirmed; inspect its native receipt',
              );
            session.reconnectedAt = this.timestamp();
            await this.persist();
            this.emitRuntime();
            return { session, nativeSession: observed.session, reused: true, reconnected: true };
          } else {
            continuation = observed.session;
            this.persisted!.pendingNativeSessionId = id;
          }
        }
      }
    }
    const configuredRunner = continuation ? session.runner : (params.runner ?? session.runner);
    const { runner, model, effort } = resolveCopilotRunner({
      runner: configuredRunner,
      model: continuation
        ? session.model
        : (params.model ?? (configuredRunner === session.runner ? session.model : undefined)),
      effort: continuation
        ? session.effort
        : (params.effort ?? (configuredRunner === session.runner ? session.effort : undefined)),
    });
    const safetyTier = continuation
      ? session.safetyTier
      : (params.safetyTier ?? (localAutostart ? 'dangerous' : 'sandboxed'));
    if (safetyTier === 'full-auto')
      throw new Error('Co-Pilot supports sandboxed or explicitly confirmed dangerous starts');
    const binding = dangerousLaunchBinding({ checkout: session.checkout, runner, model, effort });
    if (safetyTier === 'dangerous' && !localAutostart && !continuation)
      assertDangerousConfirmation(binding, params.confirmation);
    // An interrupted ensure keeps its precommitted UUID. A terminal process requires an explicit
    // new Start and a fresh UUID, never an uncertain resume or a replayed first message.
    const attempt = this.persisted!.pendingNativeSessionId ?? randomUUID();
    const commandId = `copilot-bootstrap:${attempt}`;
    const startedAt = this.timestamp();
    Object.assign(session, {
      runner,
      model,
      effort,
      safetyTier,
      status: 'starting',
      nativeSession: { sessionId: attempt, executionNodeId: 'local' },
      startedAt,
      updatedAt: startedAt,
      createdAt: session.createdAt ?? startedAt,
      dangerousLaunch: binding,
      lastDelivery: this.idleDelivery(startedAt),
    });
    this.persisted!.nativeOwnerPrincipalId = owner;
    this.persisted!.pendingNativeSessionId = attempt;
    delete this.persisted!.stoppedNativeSessionId;
    this.watchNative(owner);
    await this.persist();
    this.emitRuntime();
    const brief = await this.buildBootstrap({
      runtime: { runner, model, safetyTier, nativeSession: session.nativeSession },
      checkout: session.checkout,
      workload: this.workload(true),
    });
    await this.store.writeBootstrap(brief);
    const originator = currentSessionOriginator();
    const requester: NativeSessionRequester | undefined =
      originator.kind === 'principal'
        ? {
            principalId: originator.principalId,
            principalGeneration: originator.principalGeneration ?? 0,
          }
        : undefined;
    authorize();
    if (this.hasStopIntent(attempt)) throw new Error('Co-Pilot start was stopped');
    const info =
      continuation ??
      (await this.native.ensure(
        owner,
        {
          sessionId: attempt,
          runner,
          model,
          effort,
          executionNodeId: 'local',
          cwd: session.checkout.path,
          mode: 'default',
          approvalMode: safetyTier === 'dangerous' ? 'bypass' : 'ask',
        },
        requester,
      ));
    if (
      info.workerManaged ||
      info.ownerPrincipalId !== owner ||
      info.id !== attempt ||
      info.executionNodeId !== 'local'
    )
      throw new Error('Co-Pilot native identity changed during ensure');
    if (this.disposed) throw new Error('Co-Pilot controller closed during launch');
    if (['closed', 'failed'].includes(info.state)) {
      if (!info.processPid || info.processStopped) {
        this.persisted!.stoppedNativeSessionId = info.id;
        delete this.persisted!.pendingNativeSessionId;
        await this.persist();
      }
      throw new Error('The previous native launch stopped; explicitly start a fresh conversation');
    }
    if (this.hasStopIntent(attempt)) {
      await this.native.close(owner, attempt);
      throw new Error('Co-Pilot start was stopped');
    }
    if (this.owner() !== owner)
      throw new Error('Co-Pilot owner changed during launch; stop the original session');
    authorize();
    await this.native.send(
      owner,
      attempt,
      commandId,
      `Read ${this.store.bootstrapPath} completely, then supervise this Gateway as its single Co-Pilot. Context is not authorization. Use typed farm reads. Propose side effects for operator confirmation; never approve, publish, merge, dispatch or fan out without it.`,
    );
    const observed = await this.native.commandStatus(owner, attempt, commandId, true);
    if (this.disposed) throw new Error('Co-Pilot controller closed during launch');
    this.applyCommandObservation(observed);
    await this.persist();
    this.emitRuntime();
    if (session.status !== 'running')
      throw new Error(
        'Co-Pilot bootstrap acceptance is unconfirmed. Check the native command receipt before retrying.',
      );
    session.workload = this.workload(true);
    session.updatedAt = this.timestamp();
    await this.persist();
    await this.audit('start', { runner, model, effort, safetyTier, sessionId: attempt });
    this.emitRuntime();
    return {
      session,
      nativeSession: observed.session,
      reused: Boolean(continuation),
      reconnected: Boolean(continuation),
    };
  }
  async stop(
    params: CopilotStopParams = {},
    authorize: () => void = () => {},
  ): Promise<CopilotStopResult> {
    const { session } = await this.status();
    let settledLaunchFailure: string | undefined;
    this.legacyCandidates = await this.tmux.listCandidates(COPILOT_TMUX_SESSION);
    if (this.legacyCandidates.length) {
      if (
        !this.legacyOwned ||
        this.legacyCandidates.length !== 1 ||
        this.legacyCandidates[0] !== COPILOT_TMUX_SESSION
      )
        throw new Error('Refusing to stop an unowned or ambiguous legacy Co-Pilot terminal');
      authorize();
      await this.tmux.kill(COPILOT_TMUX_SESSION);
      this.legacyOwned = false;
      this.legacyCandidates = [];
    }
    if (session.nativeSession) {
      const owner = this.owner();
      if (owner !== this.persisted!.nativeOwnerPrincipalId)
        throw new Error('Co-Pilot native execution owner changed');
      const id = session.nativeSession.sessionId;
      authorize();
      session.status = 'stopping';
      await this.persist();
      this.emitRuntime();
      const closeIfPresent = async () => {
        let observed: NativeSessionInfo;
        try {
          observed = await this.native.inspect(owner, id);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')
            return;
          throw error;
        }
        this.assertNative(observed, owner, id);
        if (observed.state === 'closed' && observed.processStopped) return;
        authorize();
        await this.native.close(owner, id);
      };
      // Close a materialized process promptly. A pre-ensure reservation remains fenced
      // until its in-flight launch settles, then the host confirms absence or closure.
      await closeIfPresent();
      if (this.startPromise) {
        const [launch] = await Promise.allSettled([this.startPromise]);
        if (launch.status === 'rejected')
          settledLaunchFailure =
            launch.reason instanceof Error ? launch.reason.message : String(launch.reason);
        await closeIfPresent();
      }
      this.persisted!.stoppedNativeSessionId = id;
    }
    session.status = 'stopped';
    session.stoppedAt = this.timestamp();
    session.updatedAt = session.stoppedAt;
    session.terminalReason = params.reason?.trim() || 'operator-requested';
    session.workload = this.workload(false);
    delete this.persisted!.pendingNativeSessionId;
    // Keep the shared metadata listener so an open closed history hears host recovery.
    // It owns no transcript tap, collector or timer.
    await this.persist();
    await this.audit('stop', {
      reason: session.terminalReason,
      ...(settledLaunchFailure ? { settledLaunchFailure } : {}),
    });
    this.emitRuntime();
    return { ok: true, session };
  }
  private backgroundFailed(error: unknown): void {
    // Stop the failed observer. The next status read persists/reports this failure and
    // can recover after storage/source repair; it never retries a model command.
    this.backgroundFailure = error instanceof Error ? error : new Error(String(error));
    this.stopNative?.();
    this.stopNative = undefined;
    this.watchedOwner = undefined;
  }
  private watchNative(owner: string): void {
    if (this.watchedOwner === owner) return;
    this.stopNative?.();
    this.watchedOwner = owner;
    this.stopNative = this.observeNative(owner, () => {
      const target = this.persisted?.session.nativeSession;
      if (target && this.persisted?.stoppedNativeSessionId === target.sessionId)
        resourceRevisions.advance({ family: 'copilot', ownerId: 'gateway-copilot' });
      void this.reconcile(true).catch((error) => this.backgroundFailed(error));
    });
  }
  private resumedReason(): string {
    return 'This Co-Pilot was resumed from another native view. Stop it before starting another.';
  }
  private async retiredNativeResumed(owner: string, id: string): Promise<boolean> {
    let info: NativeSessionInfo;
    try {
      info = await this.native.inspect(owner, id);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND')
        return false;
      throw error;
    }
    this.assertNative(info, owner, id);
    return (
      !['closed', 'failed'].includes(info.state) || Boolean(info.processPid && !info.processStopped)
    );
  }
  private isStopping(): boolean {
    return this.persisted?.session.status === 'stopping';
  }
  private hasStopIntent(id: string): boolean {
    return this.isStopping() || this.persisted?.stoppedNativeSessionId === id;
  }
  private assertNative(info: NativeSessionInfo, owner: string, id: string): void {
    if (
      info.workerManaged ||
      info.ownerPrincipalId !== owner ||
      info.id !== id ||
      info.executionNodeId !== 'local'
    )
      throw new Error('Co-Pilot native source identity changed');
  }
  private applyCommandObservation(observed: NativeCommandObservation): void {
    const session = this.persisted!.session;
    const id = session.nativeSession?.sessionId;
    if (
      !id ||
      observed.session.id !== id ||
      session.status === 'stopping' ||
      this.persisted!.stoppedNativeSessionId === id
    )
      return;
    this.assertNative(observed.session, this.persisted!.nativeOwnerPrincipalId!, id);
    const receipt = observed.receipt;
    if (['closed', 'failed'].includes(observed.session.state)) {
      session.status = 'stopped';
      session.terminalReason =
        observed.session.recovery ?? observed.session.error ?? 'native-session-stopped';
      if (!observed.session.processPid || observed.session.processStopped) {
        this.persisted!.stoppedNativeSessionId = id;
        delete this.persisted!.pendingNativeSessionId;
      }
    } else if (receipt?.accepted && receipt.generation === observed.session.generation) {
      session.status = 'running';
      delete this.persisted!.pendingNativeSessionId;
      delete session.terminalReason;
    } else {
      if (
        session.lastDelivery.id === `copilot-bootstrap:${id}` &&
        session.lastDelivery.state === 'accepted'
      )
        return;
      session.status =
        receipt?.state === 'failed' || (receipt?.state === 'unknown' && !this.startPromise)
          ? 'failed'
          : 'starting';
      session.terminalReason = receipt
        ? 'Awaiting a confirmed native bootstrap receipt'
        : 'Bootstrap has not been submitted; explicitly Start to continue';
    }
    if (receipt)
      session.lastDelivery = {
        id: `copilot-bootstrap:${id}`,
        state: receipt.accepted ? 'accepted' : 'deferred',
        requestedAt: session.startedAt ?? this.timestamp(),
        ...(receipt.accepted ? { settledAt: this.timestamp() } : {}),
        ...(!receipt.accepted ? { reason: session.terminalReason } : {}),
      };
  }
  private reconcile(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reconciling) {
      this.reconcileAgain ||= force;
      return this.reconciling;
    }
    if (!force && this.now().getTime() - this.checkedAt < RECONCILE_MS) return Promise.resolve();
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        this.checkedAt = this.now().getTime();
        await this.reconcileOnce();
      } while (this.reconcileAgain);
    })().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }
  private async reconcileOnce(): Promise<void> {
    const session = this.persisted?.session;
    if (!session?.nativeSession) {
      this.legacyCandidates = await this.tmux.listCandidates(COPILOT_TMUX_SESSION);
      if (session && this.legacyCandidates.length) {
        session.status =
          this.legacyOwned && this.legacyCandidates.length === 1 ? 'running' : 'ambiguous';
        session.terminalReason = this.legacyReason();
      } else if (session && ['starting', 'running', 'reconnecting'].includes(session.status)) {
        session.status = 'stopped';
        session.terminalReason = 'legacy-terminal-missing';
      }
      return;
    }
    if (this.isStopping()) return;
    const expected = session.nativeSession.sessionId;
    try {
      if (this.persisted!.stoppedNativeSessionId === expected) {
        const resumed = await this.retiredNativeResumed(
          this.persisted!.nativeOwnerPrincipalId!,
          expected,
        );
        if (
          this.disposed ||
          this.isStopping() ||
          this.persisted?.session.nativeSession?.sessionId !== expected
        )
          return;
        session.status = resumed ? 'failed' : 'stopped';
        if (resumed) session.terminalReason = this.resumedReason();
        await this.persist();
        this.emitRuntime();
        return;
      }
      if (this.persisted!.nativeOwnerPrincipalId)
        this.watchNative(this.persisted!.nativeOwnerPrincipalId);
      const owner = this.owner();
      if (owner !== this.persisted!.nativeOwnerPrincipalId)
        throw new Error('Co-Pilot native execution owner changed');
      const observed = await this.native.commandStatus(
        owner,
        expected,
        `copilot-bootstrap:${expected}`,
      );
      if (
        this.disposed ||
        this.persisted?.session.nativeSession?.sessionId !== expected ||
        this.hasStopIntent(expected)
      )
        return;
      this.applyCommandObservation(observed);
      if (!this.initialized && session.status === 'running')
        session.reconnectedAt = this.timestamp();
    } catch (error) {
      if (
        this.persisted?.session.nativeSession?.sessionId !== expected ||
        this.persisted.session.status === 'stopping'
      )
        return;
      session.status = this.hasStopIntent(expected) ? 'failed' : 'reconnecting';
      session.terminalReason = (error as Error).message;
    }
    await this.persist();
    this.emitRuntime();
  }
  /** Retire this gateway reader without stopping the detached native conversation. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopNative?.();
    this.stopNative = undefined;
    this.watchedOwner = undefined;
    await this.reconciling;
  }
  private legacyReason(): string {
    return 'A legacy Co-Pilot terminal is still active. Open Terminals; explicitly stop it before starting the native Co-Pilot. Its conversation and archive remain unchanged.';
  }
  private workload(copilotRunning: boolean): CopilotWorkloadSnapshot {
    if (this.workloadOverride) return this.workloadOverride(copilotRunning);
    const fleet = getCachedFleet();
    const resources: WorkloadResourceInput[] = (fleet?.slots ?? []).flatMap((slot) =>
      [...(getActiveResources(slot.slot)?.entries() ?? [])].map(([resourceId, pointer]) => ({
        slotId: slot.slot,
        resourceId,
        pointer,
      })),
    );
    return buildCopilotWorkloadSnapshot({
      runs: getAllRuns(),
      fleet,
      resources,
      copilotRunning,
      localHost: os.hostname().replace(/\.local$/, ''),
    });
  }
  private idleDelivery(now: string): CopilotDelivery {
    return { id: 'none', state: 'idle', requestedAt: now };
  }
  private timestamp(): string {
    return this.now().toISOString();
  }
  private async persist(): Promise<void> {
    if (!this.persisted) return;
    const snapshot = structuredClone(this.persisted);
    await this.store.save(snapshot);
    this.committed = snapshot.session;
    const current = JSON.stringify({ ...snapshot.session, updatedAt: undefined });
    if (current !== this.publishedSession) {
      this.publishedSession = current;
      resourceRevisions.advance({ family: 'copilot', ownerId: 'gateway-copilot' });
    }
  }
  private emitRuntime(): void {
    if (this.committed) this.emit(Events.COPILOT_RUNTIME_UPDATED, { session: this.committed });
  }
  private async audit(
    action: CopilotAuditRecord['action'],
    detail: Record<string, unknown>,
  ): Promise<void> {
    const session = this.persisted?.session;
    if (session)
      await this.store.appendAudit({
        id: randomUUID(),
        ts: this.timestamp(),
        action,
        runtimeId: session.runtimeId,
        safetyTier: session.safetyTier,
        checkout: session.checkout.path,
        branch: session.checkout.branch,
        head: session.checkout.head,
        detail,
      });
  }
}
let runtimeController: CopilotRuntimeController | null = null;
export async function initCopilotRuntime(emit: Emit): Promise<CopilotRuntimeController> {
  runtimeController = new CopilotRuntimeController({ emit });
  await runtimeController.initialize();
  return runtimeController;
}
export function getCopilotRuntime(): CopilotRuntimeController {
  return (runtimeController ??= new CopilotRuntimeController());
}
export function setCopilotRuntimeForTests(controller: CopilotRuntimeController | null): void {
  runtimeController = controller;
}
