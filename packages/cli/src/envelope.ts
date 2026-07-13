// envelope.ts — machine-first output contract for operator commands.
// Machine mode (--json or non-TTY stdout) emits exactly one envelope on stdout;
// progress/spinners stay on stderr. Errors always teach the escape: every error
// envelope carries a userAction naming the next command(s) for THIS situation.
// Documented at docs/reference/cli-machine-envelope.md.

import type { Command } from 'commander';

import type { OutputContext } from './output.js';

export const CLI_ENVELOPE_SCHEMA_VERSION = 1 as const;

export interface CliEnvelopeError {
  code: string;
  message: string;
  userAction: string;
  details?: unknown;
}

export interface CliEnvelope {
  schemaVersion: typeof CLI_ENVELOPE_SCHEMA_VERSION;
  command: string;
  status: 'ok' | 'error';
  exitCode: number;
  data?: unknown;
  error?: CliEnvelopeError;
}

/** Machine mode is opt-in via --json or implied by a non-TTY stdout (piped/scripted). */
export function isMachineMode(output: OutputContext): boolean {
  return output.json || !(process.stdout.isTTY ?? false);
}

export function okEnvelope(command: string, data: unknown): CliEnvelope {
  return { schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION, command, status: 'ok', exitCode: 0, data };
}

export function errorEnvelope(command: string, err: unknown): CliEnvelope {
  const source = err as { code?: unknown; userAction?: unknown; details?: unknown };
  const code = typeof source?.code === 'string' && source.code ? source.code : 'CLI_ERROR';
  const userAction =
    typeof source?.userAction === 'string' && source.userAction
      ? source.userAction
      : fallbackUserAction(err);
  return {
    schemaVersion: CLI_ENVELOPE_SCHEMA_VERSION,
    command,
    status: 'error',
    exitCode: 1,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      userAction,
      ...(source?.details !== undefined ? { details: source.details } : {}),
    },
  };
}

function fallbackUserAction(err: unknown): string {
  if (err instanceof Error && err.name === 'GatewayConnectionError') {
    return 'Start the gateway with `farmslot up` (or `yarn farmdev` in a dev checkout), or target a running one via --url/--gateway. Diagnose with `farmslot doctor`.';
  }
  return 'Re-run with --json for machine-readable details and diagnose with `farmslot doctor`.';
}

/** Dotted command path, e.g. `slot.prepare`, derived from the commander tree (root name dropped). */
export function commandPathOf(cmd: Command): string {
  const names: string[] = [];
  for (let current: Command | null = cmd; current; current = current.parent) {
    names.unshift(current.name());
  }
  return (names[0] === 'farmslot' ? names.slice(1) : names).join('.');
}

export interface EnvelopeEmitter {
  /** True under --json or non-TTY stdout; human rendering must be skipped. */
  machine: boolean;
  ok(data: unknown): void;
  /** Emits an error envelope (machine) or teach-the-escape text (human); never exits 0. */
  fail(err: unknown): void;
}

export function createEmitter(output: OutputContext, cmd: Command): EnvelopeEmitter {
  const command = commandPathOf(cmd);
  const machine = isMachineMode(output);
  return {
    machine,
    ok(data: unknown): void {
      output.writeJson(okEnvelope(command, data));
    },
    fail(err: unknown): void {
      if (machine) {
        const envelope = errorEnvelope(command, err);
        output.writeJson(envelope);
        process.exitCode = envelope.exitCode;
      } else {
        output.failure(err);
      }
    },
  };
}
