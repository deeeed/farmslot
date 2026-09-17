// Farmslot PI extension: map PI events onto hooks.jsonl. Loaded with `pi -e`.
// Do not import @earendil-works/pi-coding-agent — PI's jiti provides `pi` at load.
import path from 'node:path';

import { writePiHook } from './pi-farmslot-hook-writer.mjs';
import { resolvePiProviderCatalog } from './pi-farmslot-providers.mjs';

function obsDir() {
  return process.env.FARMSLOT_OBS_DIR || path.join(process.cwd(), '.agent', '.observability');
}

function sessionIdFrom(ctx: { sessionManager?: { getSessionFile?: () => string | null } }) {
  const file = ctx.sessionManager?.getSessionFile?.() ?? '';
  if (!file) return 'pi-session';
  return path.basename(file).replace(/\.jsonl?$/, '') || 'pi-session';
}

function promptText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  return null;
}

export default async function (pi: {
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerProvider?: (id: string, provider: Record<string, unknown>) => void;
}) {
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

  pi.on('project_trust', async () => ({ trusted: 'yes' as const }));

  pi.on(
    'session_start',
    async (
      _event: unknown,
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      writePiHook({
        obsDir: obsDir(),
        event: 'SessionStart',
        sessionId: sessionIdFrom(ctx),
        cwd: ctx.cwd,
      });
    },
  );

  pi.on(
    'input',
    async (
      event: { text?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      const text = promptText(event.text);
      if (!text) return;
      writePiHook({
        obsDir: obsDir(),
        event: 'UserPromptSubmit',
        sessionId: sessionIdFrom(ctx),
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
        sessionId: sessionIdFrom(ctx),
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
        sessionId: sessionIdFrom(ctx),
        toolName: event.toolName,
        cwd: ctx.cwd,
      });
    },
  );

  pi.on(
    'agent_settled',
    async (
      _event: unknown,
      ctx: { cwd?: string; sessionManager?: { getSessionFile?: () => string | null } },
    ) => {
      writePiHook({
        obsDir: obsDir(),
        event: 'Stop',
        sessionId: sessionIdFrom(ctx),
        cwd: ctx.cwd,
      });
    },
  );
}
