// Farmslot PI extension: hooks, task delivery, mark/signal tools, HUD, slash cmds.
// Pi's jiti supplies the extension API and resolves the host SDK when needed.
import { writeSync } from 'node:fs';
import path from 'node:path';

import { Type } from 'typebox';

import { piMessageTokenUsage, piTurnFailure, writePiHook } from './pi-farmslot-hook-writer.mjs';
import {
  assertPiModelThinking,
  deadlinePiFetch,
  PiProviderConfigurationError,
  piSdkModels,
  preservePiStaticModels,
  providerReasoningFetch,
  resolvePiProviderCatalog,
} from './pi-farmslot-providers.mjs';
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

interface PiProviderDiscoverySource {
  provider: string;
  configured: boolean;
  status: 'ready' | 'failed';
  modelCount: number;
}

interface PiThinkingModel {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

interface PiShutdownContext {
  abort: () => void;
  shutdown: () => void;
  cwd?: string;
  sessionManager?: { getSessionFile?: () => string | null };
}

export default async function (pi: {
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerProvider?: (id: string, provider: Record<string, unknown>) => void;
  appendEntry?: (type: string, data: Record<string, unknown>) => void;
  registerTool?: (tool: Record<string, unknown>) => void;
  registerCommand?: (name: string, spec: Record<string, unknown>) => void;
  sendUserMessage?: (text: string) => void;
}) {
  let configurationFailure: string | null = null;
  let shutdownContext: PiShutdownContext | undefined;
  const stopPiConfiguration = (error: PiProviderConfigurationError) => {
    if (configurationFailure) return;
    configurationFailure = `[farmslot-pi] configuration error: ${error.message}`;
    writePiHook({
      obsDir: obsDir(),
      event: 'StopFailure',
      failure: configurationFailure,
      ...sessionFrom(shutdownContext ?? {}),
      cwd: shutdownContext?.cwd,
    });
    // Pi 1.4.0's orderly shutdown explicitly calls exit(0). An exit listener
    // preserves failure after Pi restores its terminal and disposes extensions.
    process.once('exit', () => {
      process.exitCode = 1;
    });
    shutdownContext?.abort();
    shutdownContext?.shutdown();
  };
  const checkThinking = (model: PiThinkingModel | undefined, ctx: PiShutdownContext) => {
    shutdownContext = ctx;
    try {
      assertPiModelThinking(model, process.env.FARMSLOT_THINKING);
      return true;
    } catch (error) {
      if (!(error instanceof PiProviderConfigurationError)) throw error;
      stopPiConfiguration(error);
      return false;
    }
  };
  const timeoutMs = Number(process.env.FARMSLOT_PI_REQUEST_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('FARMSLOT_PI_REQUEST_TIMEOUT_MS must be a positive integer');
  let timeoutFailure: string | null = null;
  let abortOperation: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  const boundedFetch = deadlinePiFetch(originalFetch, timeoutMs, () => {
    if (abortOperation) {
      timeoutFailure = `Pi model request timed out after ${timeoutMs}ms and one retry`;
      abortOperation();
    }
  });
  let requestFetch: typeof globalThis.fetch = boundedFetch;
  const ownedFetch: typeof globalThis.fetch = (input, options) => requestFetch(input, options);
  globalThis.fetch = ownedFetch;
  pi.on('session_shutdown', async () => {
    // Cached SDK clients may retain this fetch function after Pi invalidates the
    // old extension runtime. Retire its recorder even when another wrapper owns global fetch.
    if (configurationFailure) writeSync(2, `${configurationFailure}\n`);
    requestFetch = originalFetch;
    if (globalThis.fetch === ownedFetch) globalThis.fetch = originalFetch;
  });
  try {
    const sources: PiProviderDiscoverySource[] = [];
    const discovered = await resolvePiProviderCatalog(process.env, {
      onDiscovery: (source: PiProviderDiscoverySource) => sources.push(source),
    });
    const catalog = await preservePiStaticModels(discovered, async (modelsPath: string) => {
      // Resolve through Pi's loader, not the copied .mjs helper's Node resolver.
      const sdk = '@earendil-works/pi-coding-agent';
      const ai = '@earendil-works/pi-ai';
      const { ModelRuntime } = await import(sdk);
      const { InMemoryCredentialStore } = await import(ai);
      return ModelRuntime.create({
        modelsPath,
        refreshOnCreate: false,
        credentials: new InMemoryCredentialStore(),
      });
    });
    // Structured catalog metadata only. Worker launches keep their normal stdout contract.
    if (process.argv.includes('--list-models'))
      writeSync(1, `${JSON.stringify({ type: 'farmslot.pi-provider-discovery', sources })}\n`);
    requestFetch = providerReasoningFetch(
      boundedFetch,
      catalog,
      (configuration) => {
        console.error('[farmslot-pi] request', JSON.stringify(configuration));
        pi.appendEntry?.('farmslot-model-request', configuration);
      },
      process.env.FARMSLOT_THINKING,
      stopPiConfiguration,
    );
    for (const source of catalog) {
      pi.registerProvider?.(source.id, {
        name: source.name,
        baseUrl: source.baseUrl,
        apiKey: source.apiKey,
        api: 'openai-completions',
        models: piSdkModels(source.models),
      });
      for (const model of source.models)
        console.error(
          '[farmslot-pi] registered',
          JSON.stringify({
            provider: source.id,
            model: model.id,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            reasoning: model.reasoning,
            cost: model.cost,
          }),
        );
    }
  } catch (error) {
    if (error instanceof PiProviderConfigurationError) throw error;
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

  pi.on('model_select', (event: { model: PiThinkingModel }, ctx: PiShutdownContext) => {
    checkThinking(event.model, ctx);
  });

  pi.on(
    'session_start',
    async (
      _event: unknown,
      ctx: PiShutdownContext & {
        hasUI?: boolean;
        model?: PiThinkingModel;
        ui?: { setStatus?: (key: string, text: string) => void };
      },
    ) => {
      if (!checkThinking(ctx.model, ctx)) return;
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
      const failure = configurationFailure ?? timeoutFailure ?? terminalFailure;
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
