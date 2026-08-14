import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CopilotCheckoutIdentity, CopilotWorkloadSnapshot } from '@farmslot/protocol';

import { CopilotRuntimeController, type CopilotRuntimeControllerOptions } from './controller.js';
import { type CopilotTmuxAdapter, createCopilotRunnerVars } from './launcher.js';
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
      independentReview: 0,
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
  launchCount = 0;
  killCount = 0;
  listCount = 0;
  transcriptPath = '';

  async listCandidates(session: string): Promise<string[]> {
    this.listCount += 1;
    return [...this.sessions]
      .filter((candidate) => candidate === session || candidate.startsWith(`${session}-`))
      .sort();
  }

  async launch(session: string): Promise<{ paneId?: string }> {
    this.launchCount += 1;
    this.sessions.add(session);
    return { paneId: '%99' };
  }

  async configureTranscript(_target: string, transcriptPath: string): Promise<void> {
    this.transcriptPath = transcriptPath;
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await writeFile(transcriptPath, '', { flag: 'a' });
  }

  async kill(session: string): Promise<void> {
    if (this.sessions.delete(session)) this.killCount += 1;
  }
}

export function testController(input: {
  home: string;
  checkout: string;
  tmux?: FakeCopilotTmux;
  sendInstruction?: CopilotRuntimeControllerOptions['sendInstruction'];
  interrupt?: CopilotRuntimeControllerOptions['interrupt'];
  checkoutIdentity?: CopilotCheckoutIdentity;
  emit?: (event: string, payload: unknown) => void;
  now?: () => Date;
}) {
  const tmux = input.tmux ?? new FakeCopilotTmux();
  const checkoutIdentity = input.checkoutIdentity ?? testCheckout(input.checkout);
  const controller = new CopilotRuntimeController({
    store: new CopilotRuntimeStore(input.home),
    tmux,
    checkout: input.checkout,
    emit: input.emit,
    now: input.now,
    inspectCheckout: async () => ({ ...checkoutIdentity }),
    buildBootstrap: async () => '# deterministic test bootstrap',
    buildLaunch: ({ checkout, runner }) => ({
      command: `${runner} --test-launch`,
      commandHash: 'launch-command-hash',
      vars: createCopilotRunnerVars(checkout),
    }),
    sendInstruction: async (...args) =>
      input.sendInstruction ? input.sendInstruction(...args) : true,
    interrupt: async (...args) => (input.interrupt ? input.interrupt(...args) : true),
    workload: testWorkload,
    resolveRuntimeDir: async () => '.agent',
    resolveTerminalWorker: async (session) => ({
      nodeId: 'test-node',
      session,
      window: '0',
      windowName: 'agent',
      pane: '0',
      paneId: '%99',
      target: '%99',
    }),
  });
  return { controller, tmux, checkoutIdentity };
}
