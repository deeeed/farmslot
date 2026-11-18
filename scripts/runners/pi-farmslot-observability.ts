// Farmslot PI extension: hooks, task delivery, mark/signal tools, HUD, slash cmds.
// Pi's jiti supplies the extension API and resolves the host SDK when needed.
import { writeSync } from 'node:fs';
import path from 'node:path';

import type { Provider } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import {
  piMessageTokenUsage,
  piTurnFailure,
  writePiHook,
  writePiReasoningReceipt,
} from './pi-farmslot-hook-writer.mjs';
import {
  assertPiModelThinking,
  deadlinePiFetch,
  PI_REQUEST_TIMEOUT_RETRIES,
  PiProviderConfigurationError,
  piProviderCredentialEnvironment,
  piSdkModels,
  preservePiStaticModels,
  providerReasoningFetch,
  releasePiProviderCredentials,
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
  registerProvider?: {
    (id: string, provider: Record<string, unknown>): void;
    (provider: Provider): void;
  };
  appendEntry?: (type: string, data: Record<string, unknown>) => void;
  registerTool?: (tool: Record<string, unknown>) => void;
  registerCommand?: (name: string, spec: Record<string, unknown>) => void;
  sendUserMessage?: (text: string) => void;
}) {
  const providerKinds = new Map<string, string>();
  let selectedModel: PiThinkingModel | undefined;
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
      assertPiModelThinking(
        model,
        process.env.FARMSLOT_THINKING,
        model && providerKinds.get(model.provider),
      );
      selectedModel = model;
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
  const timeoutMode = process.env.FARMSLOT_PI_REQUEST_TIMEOUT_MODE ?? 'total';
  if (timeoutMode !== 'total' && timeoutMode !== 'idle')
    throw new Error('FARMSLOT_PI_REQUEST_TIMEOUT_MODE must be total or idle');
  // Allow retry backoff, terminal-hook persistence and gateway observation after exhaustion.
  const retrySettlementMarginMs = 30_000;
  const startupGraceMs =
    timeoutMode === 'idle'
      ? null // Response chunks can extend an idle deadline until the overall review deadline.
      : timeoutMs * (PI_REQUEST_TIMEOUT_RETRIES + 1) + retrySettlementMarginMs;
  let timeoutFailure: string | null = null;
  // Only an abort WE caused may be reported as a request timeout. `timeoutFailure`
  // is sticky for the rest of the turn, and it used to be read ahead of the turn's
  // own ending, so a turn that ended some other way inherited the timeout text
  // (36cc77e1 reported "timed out after 300000ms and one retry" for a turn that
  // was aborted 8 s after an unrelated warning).
  let abortedByTimeout = false;
  let abortOperation: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  const boundedFetch = deadlinePiFetch(
    originalFetch,
    timeoutMs,
    () => {
      if (abortOperation) {
        timeoutFailure = `Pi model request timed out after ${timeoutMs}ms and one retry`;
        abortedByTimeout = true;
        abortOperation();
      }
    },
    timeoutMode,
  );
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
    const discovered = await resolvePiProviderCatalog(piProviderCredentialEnvironment(), {
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
        const kind = selectedModel && providerKinds.get(selectedModel.provider);
        // Saved alias sessions record assistant usage under their selected provider.
        // Keep pricing metadata on that same key without renaming another source's request.
        const record = {
          ...configuration,
          ...(selectedModel?.id === configuration.model &&
          kind !== undefined &&
          kind === providerKinds.get(configuration.provider)
            ? { provider: selectedModel.provider }
            : {}),
        };
        pi.appendEntry?.('farmslot-model-request', record);
        writePiReasoningReceipt(sessionFrom(shutdownContext ?? {}).transcriptPath, record);
      },
      process.env.FARMSLOT_THINKING,
      stopPiConfiguration,
    );
    for (const source of catalog) {
      for (const id of [source.id, ...(source.aliases ?? [])]) providerKinds.set(id, source.kind);
      pi.registerProvider?.(source.id, {
        name: source.name,
        baseUrl: source.baseUrl,
        apiKey: source.apiKey,
        api: 'openai-completions',
        models: piSdkModels(source.models),
      });
      for (const alias of source.aliases ?? []) {
        const { createProvider, openAICompletionsApi } =
          await import('@earendil-works/pi-ai/compat');
        // Pi resolves CLI and saved-session models from the full registry, while
        // its pickers and --list-models use the available-model filter.
        pi.registerProvider?.(
          createProvider({
            id: alias,
            name: source.name,
            baseUrl: source.baseUrl,
            auth: {
              apiKey: {
                name: source.name,
                resolve: async () => ({ auth: { apiKey: source.apiKey } }),
              },
            },
            models: piSdkModels(source.models).map((model) => ({
              ...model,
              provider: alias,
              baseUrl: source.baseUrl,
              api: 'openai-completions' as const,
            })),
            filterModels: () => [],
            api: openAICompletionsApi(),
          }),
        );
      }
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
    releasePiProviderCredentials(catalog);
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
      'Advance the Farmslot worker checklist. Use this instead of shelling ./mark. ' +
      'A step number is how you report progress and is what you use as you work. ' +
      "complete and blocked are the run's final disposition: they end it. " +
      'Mark complete only once every checklist step is marked — calling it earlier is refused, ' +
      'and it is not a way to record that a step is done.',
    parameters: Type.Object({
      action: Type.String({
        description:
          'A checklist step number — "1", "2", "3" — to record progress on that step. ' +
          'This is the normal value and the one you use as you work. ' +
          'The lifecycle words are rare and three of them are final: ' +
          '"start" once before the first step; ' +
          '"complete" ENDS the run and is valid only after every step is marked; ' +
          '"blocked" ENDS the run when you cannot continue; ' +
          '"no-change" ENDS the run when there was nothing to do.',
        examples: ['1', '2', '3', 'start', 'complete'],
      }),
    }),
    async execute(_toolCallId: string, params: { action?: string }, signal?: AbortSignal) {
      try {
        const output = await runFarmslotMark(params.action ?? '', process.env, signal);
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
  // so launch is not blocked on a TUI prompt. Read-only reviews retain CLI trust policy.
  const readOnlyReview = process.env.FARMSLOT_PI_WORKSPACE_TRUST === 'untrusted';
  if (!readOnlyReview) pi.on('project_trust', async () => ({ trusted: 'yes' as const }));

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
      // Print/JSON modes and read-only terminal reviews carry their prompt on argv.
      // Slot workers deliver TASK.md once so Farmslot does not tmux-type it.
      if (ctx.hasUI === false || readOnlyReview) return;
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
      abortedByTimeout = false;
      abortOperation = () => {
        // Persist before cancellation: settling can be delayed or skipped by the runner.
        writePiHook({
          obsDir: obsDir(),
          event: 'StopFailure',
          failure: timeoutFailure,
          ...sessionFrom(ctx),
          cwd: ctx.cwd,
        });
        ctx.abort();
      };
      writePiHook({
        obsDir: obsDir(),
        event: 'UserPromptSubmit',
        startupGraceMs,
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
    const outcome = typeof event.outcome === 'string' ? event.outcome : undefined;
    // A turn ended on purpose by something other than the model: a guard, an
    // operator, a cancelled session. The outcome name is carried verbatim
    // because this SDK publishes no enum for it, and a reason naming the real
    // ending beats inheriting whatever text happened to be set earlier. Only
    // names that clearly mean "stopped deliberately" are matched, so a clean
    // completion can never be turned into a failure by this branch.
    const abortedOutcome = outcome !== undefined && /abort|cancel|interrupt/i.test(outcome);
    terminalFailure = abortedByTimeout
      ? timeoutFailure
      : abortedOutcome
        ? `Pi turn was aborted before it completed (outcome=${outcome}); the model reported no failure of its own`
        : outcome === 'error'
          ? terminalFailure || 'Pi runner failed before completing its turn'
          : null;
  });

  pi.on(
    'agent_settled',
    async (
      _event: unknown,
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      // `timeoutFailure` is reported only when it is what ended the turn. Read
      // unconditionally, it outranked the turn's own ending for the rest of the
      // turn, which is how an intentional abort was labelled a model timeout.
      const failure =
        configurationFailure ?? (abortedByTimeout ? timeoutFailure : terminalFailure);
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
