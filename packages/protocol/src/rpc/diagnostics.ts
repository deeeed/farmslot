export interface DiagnosticsRunParams {
  slotId: string;
}

export interface DiagnosticsRunResult {
  diagnostics: import('../contracts/index.js').Diagnostic[];
  truncated: boolean;
}
