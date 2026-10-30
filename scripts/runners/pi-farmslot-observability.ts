// Farmslot PI extension: hooks, task delivery, mark/signal tools, HUD, slash cmds.
// Do not import @earendil-works/pi-coding-agent — PI's jiti provides `pi` at load.
import path from 'node:path';

import { Type } from 'typebox';

import { piMessageTokenUsage, piTurnFailure, writePiHook } from './pi-farmslot-hook-writer.mjs';
import { deadlinePiFetch, resolvePiProviderCatalog } from './pi-farmslot-providers.mjs';
import {
  deliverTaskOnce,
  farmslotStatusLine,
  readFarmslotSignal,
  readTaskMarkdown,
  runFarmslotMark,
} from './pi-farmslot-task.mjs';

function obsDir() {
  return process.env.FARMSLOT_OBS_DIR || path.join(process.cwd(), '.agent', '.observability');
}

function sessionFrom(ctx: { sessionManager?: { getSessionFile?: () => string | null } }) {
  const file = ctx.sessionManager?.getSessionFile?.() ?? '';
  return {
    sessionId: path.basename(file).replace(/\.jsonl?$/, '') || `pi-session-${process.pid}`,
    transcriptPath: file || undefined,
  };
}

function promptText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function toolResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
    isError,
  };
}

export default async function (pi: {
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerProvider?: (id: string, provider: Record<string, unknown>) => void;
  registerTool?: (tool: Record<string, unknown>) => void;
  registerCommand?: (name: string, spec: Record<string, unknown>) => void;
  sendUserMessage?: (text: string) => void;
}) {
  const timeoutMs = Number(process.env.FARMSLOT_PI_REQUEST_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('FARMSLOT_PI_REQUEST_TIMEOUT_MS must be a positive integer');
  let timeoutFailure: string | null = null;
  let abortOperation: (() => void) | undefined;
  const boundedFetch = deadlinePiFetch(globalThis.fetch, timeoutMs, () => {
    if (abortOperation) {
      timeoutFailure = `Pi model request timed out after ${timeoutMs}ms and one retry`;
      abortOperation();
    }
  });
  globalThis.fetch = boundedFetch;
  try {
    const catalog = await resolvePiProviderCatalog(process.env);
    for (const source of catalog) {
      pi.registerProvider?.(source.id, {
        name: source.name,
        baseUrl: source.baseUrl,
        apiKey: source.apiKey,
        api: 'openai-completions',
        models: source.models,
      });
    }
  } catch (error) {
    // Optional local/router discovery must not block xAI/Grok launch.
    if (process.env.FARMSLOT_PI_PROVIDERS_DEBUG) {
      console.error('[farmslot-pi] provider discovery failed', error);
    }
  }

  pi.registerTool?.({
    name: 'farmslot_mark',
    label: 'Farmslot mark',
    description:
      'Advance the Farmslot worker checklist. Use this instead of shelling ./mark. Pass start, complete, blocked, or a step number.',
    parameters: Type.Object({
      action: Type.String({ description: 'start | complete | blocked | a checklist step number' }),
    }),
    async execute(_toolCallId: string, params: { action?: string }) {
      try {
        const output = runFarmslotMark(params.action ?? '');
        return toolResult(output || `marked ${params.action}`);
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.registerTool?.({
    name: 'farmslot_signal',
    label: 'Farmslot signal',
    description: 'Read SIGNAL.json for this Farmslot task. Does not complete the run.',
    parameters: Type.Object({}),
    async execute() {
      try {
        const signal = readFarmslotSignal();
        return toolResult(JSON.stringify(signal, null, 2));
      } catch (error) {
        return toolResult(error instanceof Error ? error.message : String(error), true);
      }
    },
  });

  pi.registerCommand?.('farmslot', {
    description: 'Show Farmslot slot/run/thinking status',
    handler: async (
      _args: string,
      ctx: { ui?: { notify?: (text: string, kind?: string) => void } },
    ) => {
      ctx.ui?.notify?.(farmslotStatusLine(), 'info');
    },
  });

  pi.registerCommand?.('farmslot-task', {
    description: 'Re-deliver TASK.md to the agent',
    handler: async (
      _args: string,
      ctx: { ui?: { notify?: (text: string, kind?: string) => void } },
    ) => {
      const text = readTaskMarkdown();
      if (!text?.trim()) {
        ctx.ui?.notify?.('No FARMSLOT_TASK_FILE', 'error');
        return;
      }
      // An explicit operator request bypasses automatic-delivery deduplication.
      pi.sendUserMessage?.(text);
    },
  });

  // Operator-owned slot: this extension is copied per run. Auto-trust this checkout
  // so launch is not blocked on a TUI prompt. Do not persist (`remember`).
  pi.on('project_trust', async () => ({ trusted: 'yes' as const }));

  pi.on(
    'session_start',
    async (
      _event: unknown,
      ctx: {
        cwd?: string;
        hasUI?: boolean;
        sessionManager?: { getSessionFile?: () => string | null };
        ui?: { setStatus?: (key: string, text: string) => void };
      },
    ) => {
      writePiHook({
        obsDir: obsDir(),
        event: 'SessionStart',
        ...sessionFrom(ctx),
        cwd: ctx.cwd,
      });
      ctx.ui?.setStatus?.('farmslot', farmslotStatusLine());
      // Print/JSON modes already have the prompt on argv (`-p`). Interactive
      // dispatch delivers TASK.md once so Farmslot does not tmux-type it.
      if (ctx.hasUI === false) return;
      await deliverTaskOnce({
        obsDir: obsDir(),
        sessionId: sessionFrom(ctx).sessionId,
        sendUserMessage: pi.sendUserMessage?.bind(pi),
      });
    },
  );

  pi.on(
    'input',
    async (
      event: { text?: string },
      ctx: {
        cwd?: string;
        abort: () => void;
        sessionManager?: { getSessionFile?: () => string | null };
      },
    ) => {
      const text = promptText(event.text);
      if (!text) return;
      boundedFetch.reset();
      timeoutFailure = null;
      abortOperation = () => ctx.abort();
      writePiHook({
        obsDir: obsDir(),
        event: 'UserPromptSubmit',
        ...sessionFrom(ctx),
        promptText: text,
        cwd: ctx.cwd,
      });
    },
  );

  pi.on(
    'tool_execution_start',
    async (
      event: { toolName?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      writePiHook({
        obsDir: obsDir(),
        event: 'PreToolUse',
        ...sessionFrom(ctx),
        toolName: event.toolName,
        cwd: ctx.cwd,
      });
    },
  );

  pi.on(
    'tool_execution_end',
    async (
      event: { toolName?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      writePiHook({
        obsDir: obsDir(),
        event: 'PostToolUse',
        ...sessionFrom(ctx),
        toolName: event.toolName,
        cwd: ctx.cwd,
      });
    },
  );

  let terminalFailure: string | null = null;
  pi.on(
    'message_end',
    async (
      event: { message?: unknown },
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      const usageTokens = piMessageTokenUsage(event.message);
      if (usageTokens > 0)
        writePiHook({
          obsDir: obsDir(),
          event: 'TokenUsage',
          usageTokens,
          ...sessionFrom(ctx),
          cwd: ctx.cwd,
        });
    },
  );
  pi.on('agent_start', async () => {
    terminalFailure = null;
  });
  pi.on('agent_end', async (event: { messages?: unknown }) => {
    terminalFailure = piTurnFailure(event.messages);
  });
  pi.on('agent_before_settle', async (event: { outcome?: string }) => {
    terminalFailure =
      timeoutFailure ??
      (event.outcome === 'error'
        ? terminalFailure || 'Pi runner failed before completing its turn'
        : null);
  });

  pi.on(
    'agent_settled',
    async (
      _event: unknown,
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      const failure = timeoutFailure ?? terminalFailure;
      writePiHook({
        obsDir: obsDir(),
        event: failure ? 'StopFailure' : 'Stop',
        failure,
        ...sessionFrom(ctx),
        cwd: ctx.cwd,
      });
    },
  );
}
