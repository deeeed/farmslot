import type { Command } from 'commander';

type RegisterCommand = (program: Command) => Promise<void>;

/**
 * Commands a call can register alone. Each module adds exactly one top-level command of this
 * name and nothing program-wide, so `farmslot <name> ...` loads only that module instead of the
 * whole command graph. These are the commands agents and the farm call most: RPC reads, run
 * and slot status, task markers and node plumbing. Every other call registers everything.
 */
export const LAZY_COMMANDS: Readonly<Record<string, RegisterCommand>> = {
  internal: async (program) =>
    (await import('./commands/internal.js')).registerInternalCommand(program),
  task: async (program) => (await import('./commands/task.js')).registerTaskCommand(program),
  rpc: async (program) => (await import('./commands/rpc.js')).registerRpcCommand(program),
  run: async (program) => (await import('./commands/run.js')).registerRunCommand(program),
  runs: async (program) => (await import('./commands/runs.js')).registerRunsCommand(program),
  slot: async (program) => (await import('./commands/slot.js')).registerSlotCommand(program),
  fleet: async (program) => (await import('./commands/fleet.js')).registerFleetCommand(program),
};
