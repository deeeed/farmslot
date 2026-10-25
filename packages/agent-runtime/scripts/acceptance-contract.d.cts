import type { WorkerTerminalContractDocument } from '@farmslot/protocol';

export const ACCEPTANCE_CONTRACT_VERSION: 1;
export const ACCEPTANCE_CONTRACT_INPUT: 'inputs/acceptance-contract.json';
export function effectiveAcceptanceContract(
  taskDir: string,
  base: WorkerTerminalContractDocument,
  baseBytes: string | Uint8Array,
): WorkerTerminalContractDocument;
