import type {
  CopilotConfigureParams,
  CopilotConfigureResult,
  CopilotStartParams,
  CopilotStartResult,
  CopilotStatusResult,
  CopilotStopParams,
  CopilotStopResult,
} from '@farmslot/protocol';

import { getCopilotRuntime } from '../copilot-runtime/controller.js';

export function copilotStatus(): Promise<CopilotStatusResult> {
  return getCopilotRuntime().status();
}

export function copilotConfigure(params: CopilotConfigureParams): Promise<CopilotConfigureResult> {
  return getCopilotRuntime().configure(params);
}

export function copilotStart(params: CopilotStartParams = {}): Promise<CopilotStartResult> {
  return getCopilotRuntime().start(params);
}

export function copilotStop(params: CopilotStopParams = {}): Promise<CopilotStopResult> {
  return getCopilotRuntime().stop(params);
}
