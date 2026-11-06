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

export function copilotConfigure(
  params: CopilotConfigureParams,
  authorize?: () => void,
): Promise<CopilotConfigureResult> {
  return getCopilotRuntime().configure(params, authorize);
}

export function copilotStart(
  params: CopilotStartParams = {},
  authorize?: () => void,
): Promise<CopilotStartResult> {
  return getCopilotRuntime().start(params, authorize);
}

export function copilotStop(
  params: CopilotStopParams = {},
  authorize?: () => void,
): Promise<CopilotStopResult> {
  return getCopilotRuntime().stop(params, authorize);
}
