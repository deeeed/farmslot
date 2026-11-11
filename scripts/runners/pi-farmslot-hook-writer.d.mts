export function piFailureKind(failure: unknown): 'transport' | undefined;

export interface PiHookParams {
  obsDir: string;
  event: string;
  sessionId?: string | null;
  transcriptPath?: string | null;
  promptText?: string | null;
  toolName?: string | null;
  cwd?: string | null;
  usageTokens?: number;
  failure?: string;
  env?: Record<string, string | undefined>;
}

export interface PiHookRecord {
  schemaVersion: number;
  observedAt: number;
  timestamp: number;
  hook_event_name: string;
  event: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tmuxPane?: string;
  slotId?: string;
  runner: string;
  failure?: string;
  failureKind?: 'transport';
  turnStartedAt?: number;
  turnActive?: boolean;
  lastToolProgressAt: number | null;
  lastTokenProgressAt?: number;
  rootSessionId?: string;
  runnerPromptDigest?: string;
  sentAt?: number;
}

export function writePiHook(params: PiHookParams): PiHookRecord;
