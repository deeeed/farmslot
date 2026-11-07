import { randomUUID } from 'node:crypto';

import { type NodeLinkCommand, NodeLinkFailure, type NodeLinkLease } from '@farmslot/protocol';

import { currentSessionOriginator } from '../security/work-originator.js';

import { getNode } from './machine-registry.js';
import { inspectNodeLinkPrograms, invokeNodeLink } from './node-link.js';
import { sendNodeRequest } from './node-rpc.js';

export interface LinkedPtyOptions {
  nodeId: string;
  resourceId: string;
  session: string;
  selectTarget?: string;
  cols: number;
  rows: number;
  lease?: NodeLinkLease;
  assertCurrent(): void | Promise<void>;
  onData(data: string): void;
  onExit(code: number): void;
}

export interface LinkedPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  kill(): void;
}

/** Node owns the PTY; tmux owns the worker. Input stays on the numbered node writer. */
export async function openLinkedPty(options: LinkedPtyOptions): Promise<LinkedPty> {
  const node = getNode(options.nodeId);
  if (!node?.nodePrincipal)
    throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Node execution identity is unavailable.');
  if (!node.terminalInputSequence)
    throw new NodeLinkFailure(
      'UNSUPPORTED_OPERATION',
      'Node must support numbered terminal input.',
    );
  const binary = (await inspectNodeLinkPrograms(options.nodeId, ['tmux'])).paths.tmux;
  if (!binary)
    throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Tmux is unavailable on this node.');
  const argv = [binary];
  if (options.selectTarget && options.selectTarget !== options.session) {
    argv.push('select-window', '-t', options.selectTarget, ';');
    if (/^%\d+$|\.\d+$/.test(options.selectTarget))
      argv.push('select-pane', '-t', options.selectTarget, ';');
  }
  argv.push('attach-session', '-t', `=${options.session}`);
  const principal = currentSessionOriginator();
  const id = randomUUID();
  const controller = new AbortController();
  let command: NodeLinkCommand | undefined;
  let started!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    started = resolve;
    failed = reject;
  });
  const assertCurrent = async () => {
    await options.assertCurrent();
    if (getNode(options.nodeId) !== node || !node.observationAuthority?.())
      throw new NodeLinkFailure('STALE_SOCKET', 'Terminal node connection changed.');
  };
  const result = invokeNodeLink(
    {
      operation: 'process.run',
      input: {
        argv,
        cwd: '/',
        timeoutMs: 24 * 60 * 60 * 1000,
        maxOutputBytes: 32 * 1024 * 1024,
        environment: 'login',
        terminal: { cols: options.cols, rows: options.rows },
      },
    },
    {
      commandId: id,
      target: { nodeId: options.nodeId, resourceId: options.resourceId },
      authority: {
        requester:
          principal.kind === 'principal'
            ? { principalId: principal.principalId, generation: principal.principalGeneration ?? 0 }
            : { kind: 'system' },
        executor: node.nodePrincipal,
        grantId: id,
        approvalId: id,
        approval: 'framework',
        ...(options.lease ? { lease: options.lease } : {}),
      },
      timeoutMs: 24 * 60 * 60 * 1000,
      signal: controller.signal,
      assertCurrent,
      onStarted: (value) => {
        command = value;
        started();
      },
      onOutput: (_stream, data) => options.onData(data),
      onReset: () => {
        throw new NodeLinkFailure(
          'TERMINAL_RESET_REQUIRED',
          'Reattach the terminal to redraw its current screen.',
        );
      },
    },
  );
  void result.then(
    (receipt) => {
      failed(
        new NodeLinkFailure(
          'TERMINAL_CLOSED',
          receipt.error?.message ?? 'Terminal attachment closed.',
        ),
      );
      const value = receipt.result;
      options.onExit(
        value &&
          typeof value === 'object' &&
          'exitCode' in value &&
          typeof value.exitCode === 'number'
          ? value.exitCode
          : 1,
      );
    },
    (error: unknown) => {
      failed(error);
      options.onExit(1);
    },
  );
  const timer = setTimeout(
    () =>
      failed(
        new NodeLinkFailure('TERMINAL_START_TIMEOUT', 'Node did not confirm terminal attachment.'),
      ),
    15_000,
  );
  timer.unref();
  try {
    await ready;
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    pid: 0,
    write: () => {
      throw new NodeLinkFailure(
        'POLICY_REFUSED',
        'Node PTY input requires the sequenced terminal writer.',
      );
    },
    resize: async (cols, rows) => {
      await assertCurrent();
      if (!command)
        throw new NodeLinkFailure('TERMINAL_UNAVAILABLE', 'Attachment has not started.');
      await sendNodeRequest(
        node,
        'node.link.terminal.resize',
        { command, size: { cols, rows } },
        { requireSameConnection: true, timeout: 5000 },
      );
    },
    kill: () => controller.abort(),
  };
}
