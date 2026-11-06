import type {
  CopilotCheckoutIdentity,
  CopilotWorkloadSnapshot,
  NativeCommandObservation,
  NativeSessionEnsureParams,
  NativeSessionInfo,
  NativeSessionRequester,
  NativeSessionSendResult,
} from '@farmslot/protocol';

import { CopilotRuntimeController, type CopilotRuntimeControllerOptions } from './controller.js';
import type { CopilotTmuxAdapter } from './launcher.js';
import { CopilotRuntimeStore } from './session-store.js';

export function testCheckout(checkout: string): CopilotCheckoutIdentity {
  return {
    path: checkout,
    branch: 'feat/copilot-test',
    head: '0123456789abcdef0123456789abcdef01234567',
    dirtyFileCount: 1,
    dirtyPaths: ['existing-user-change.txt'],
  };
}

export function testWorkload(running: boolean): CopilotWorkloadSnapshot {
  const copilot = running ? 1 : 0;
  return {
    severity: 'normal',
    totals: {
      implementation: 0,
      review: 0,
      reviewRework: 0,
      ciFix: 0,
      fullQa: 0,
      recipe: 0,
      prepare: 0,
      devServer: 0,
      copilot,
      total: copilot,
    },
    hosts: [],
    policy: {
      singleton: true,
      automaticCancellation: false,
      automaticDispatch: false,
      automaticFanOut: false,
    },
  };
}

export class FakeCopilotTmux implements CopilotTmuxAdapter {
  sessions = new Set<string>();
  killCount = 0;
  listCount = 0;
  async listCandidates(session: string): Promise<string[]> {
    this.listCount++;
    return [...this.sessions]
      .filter((candidate) => candidate === session || candidate.startsWith(`${session}-`))
      .sort();
  }
  async kill(session: string): Promise<void> {
    if (this.sessions.delete(session)) this.killCount++;
  }
}
export class FakeCopilotNative {
  sessions = new Map<string, NativeSessionInfo>();
  launches = 0;
  inspections = 0;
  sends = new Map<string, NativeSessionSendResult>();
  requests: Array<{
    owner: string;
    params: NativeSessionEnsureParams;
    requester?: NativeSessionRequester;
  }> = [];
  accept = true;
  beforeSend?: () => Promise<void>;
  private changes = new Set<() => void>();
  observe(change: () => void): () => void {
    this.changes.add(change);
    return () => this.changes.delete(change);
  }
  publish(): void {
    for (const change of this.changes) change();
  }
  async commandStatus(
    owner: string,
    id: string,
    commandId: string,
    waitForAcceptance = false,
  ): Promise<NativeCommandObservation> {
    const sample = async (): Promise<NativeCommandObservation> => {
      const session = await this.inspect(owner, id);
      const result = this.sends.get(commandId);
      return {
        session,
        ...(result ? { receipt: { ...result, generation: session.generation } } : {}),
      };
    };
    const initial = await sample();
    const ready = (value: NativeCommandObservation) =>
      value.receipt?.accepted ||
      ['unknown', 'failed'].includes(value.receipt?.state ?? '') ||
      ['closed', 'failed'].includes(value.session.state);
    if (!waitForAcceptance || ready(initial)) return initial;
    return new Promise((resolve) => {
      const stop = this.observe(() => {
        void sample().then((value) => {
          if (ready(value)) {
            stop();
            resolve(value);
          }
        });
      });
    });
  }
  async ensure(
    owner: string,
    params: NativeSessionEnsureParams,
    requester?: NativeSessionRequester,
  ): Promise<NativeSessionInfo> {
    this.requests.push({ owner, params, requester });
    const existing = this.sessions.get(params.sessionId);
    if (existing) return { ...existing };
    this.launches++;
    const info: NativeSessionInfo = {
      id: params.sessionId,
      executionNodeId: 'local',
      generation: 'process',
      hostPid: 1,
      runner: params.runner,
      model: params.model,
      cwd: params.cwd,
      executable: '/bin/runner',
      version: 'test',
      nativeSessionId: `conversation-${params.sessionId}`,
      ownerPrincipalId: owner,
      accountContextId: 'ambient',
      mode: params.mode ?? 'default',
      accountMode: 'native',
      state: 'idle',
      approvalMode: params.approvalMode,
      ...(requester
        ? {
            requestedByPrincipalId: requester.principalId,
            requestedByPrincipalGeneration: requester.principalGeneration,
          }
        : {}),
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    };
    this.sessions.set(info.id, info);
    return { ...info };
  }
  async inspect(owner: string, id: string): Promise<NativeSessionInfo> {
    this.inspections++;
    const info = this.sessions.get(id);
    if (!info || info.ownerPrincipalId !== owner)
      throw Object.assign(new Error('Native session unavailable'), { code: 'NOT_FOUND' });
    return { ...info };
  }
  async send(
    owner: string,
    id: string,
    commandId: string,
    _text: string,
  ): Promise<NativeSessionSendResult> {
    await this.inspect(owner, id);
    await this.beforeSend?.();
    const result = this.sends.get(commandId) ?? {
      commandId,
      state: this.accept ? 'accepted' : 'unknown',
      submitted: true,
      accepted: this.accept,
    };
    this.sends.set(commandId, result);
    this.publish();
    return result;
  }
  async close(owner: string, id: string): Promise<void> {
    const info = await this.inspect(owner, id);
    info.state = 'closed';
    info.processStopped = true;
    this.sessions.set(id, info);
    this.publish();
  }
}
export function testController(input: {
  home: string;
  checkout: string;
  tmux?: FakeCopilotTmux;
  native?: FakeCopilotNative;
  checkoutIdentity?: CopilotCheckoutIdentity;
  emit?: CopilotRuntimeControllerOptions['emit'];
  now?: () => Date;
  owner?: () => string;
  buildBootstrap?: CopilotRuntimeControllerOptions['buildBootstrap'];
}) {
  const tmux = input.tmux ?? new FakeCopilotTmux();
  const native = input.native ?? new FakeCopilotNative();
  const checkoutIdentity = input.checkoutIdentity ?? testCheckout(input.checkout);
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(input.home),
    tmux,
    native,
    owner: input.owner ?? (() => 'farm'),
    observeNative: (_owner, change) => native.observe(change),
    checkout: input.checkout,
    emit: input.emit,
    now: input.now,
    inspectCheckout: async () => ({ ...checkoutIdentity }),
    observeCheckout: async () => async () => undefined,
    buildBootstrap: input.buildBootstrap ?? (async () => '# deterministic test bootstrap'),
    workload: testWorkload,
  });
  return { controller, tmux, native, checkoutIdentity };
}
