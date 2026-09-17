// Farmslot PI extension: hooks, task delivery, mark/signal tools, HUD, slash cmds.
// Do not import @earendil-works/pi-coding-agent — PI's jiti provides `pi` at load.
import fs from 'node:fs';
import path from 'node:path';

import { Type } from 'typebox';

import { writePiHook } from './pi-farmslot-hook-writer.mjs';
import { resolvePiProviderCatalog } from './pi-farmslot-providers.mjs';
import {
  farmslotStatusLine,
  readFarmslotSignal,
  readTaskMarkdown,
  runFarmslotMark,
  taskDeliveredMarker,
} from './pi-farmslot-task.mjs';

function obsDir() {
  return process.env.FARMSLOT_OBS_DIR || path.join(process.cwd(), '.agent', '.observability');
}

function sessionIdFrom(ctx: { sessionManager?: { getSessionFile?: () => string | null } }) {
  const file = ctx.sessionManager?.getSessionFile?.() ?? '';
  if (!file) return `pi-session-${process.pid}`;
  return path.basename(file).replace(/\.jsonl?$/, '') || `pi-session-${process.pid}`;
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
        sessionId: sessionIdFrom(ctx),
        cwd: ctx.cwd,
      });
      ctx.ui?.setStatus?.('farmslot', farmslotStatusLine());
      // Print/JSON modes already have the prompt on argv (`-p`). Interactive
      // dispatch delivers TASK.md once so Farmslot does not tmux-type it.
      if (ctx.hasUI === false) return;
      const task = readTaskMarkdown();
      if (!task?.trim()) return;
      const marker = taskDeliveredMarker(obsDir());
      if (fs.existsSync(marker)) return;
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${Date.now()}\n`);
      pi.sendUserMessage?.(task);
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
