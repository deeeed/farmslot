// attachment-provider.ts — Runner capability layer for terminal image attachments (ADR-023).
//
// The gateway stages an image on the slot; a per-runner provider then performs the
// runner-supported delivery interaction with the staged path. Callers never branch on a
// runner id — they look the provider up here. A runner with no entry is explicitly
// unsupported rather than silently best-effort.

import { normalizeRunner, type TerminalAttachmentDeliveryStatus } from '@farmslot/protocol';

import type { loadSlotVars } from '../core/config.js';

import { sendRunnerInstructionSafely } from './registry.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

export interface RunnerAttachmentContext {
  vars: SlotVars;
  /** Resolved tmux target for the runner pane (session or session:window). */
  target: string;
  /** Absolute path of the staged image on the slot machine. */
  storedPath: string;
  /** Operator-visible source name, used only in the delivery message. */
  filename: string;
  byteLength: number;
}

export interface RunnerAttachmentDeliveryResult {
  status: TerminalAttachmentDeliveryStatus;
  detail: string;
}

export interface RunnerAttachmentProvider {
  id: string;
  /** Prompt text this runner understands as "read the image at this path". */
  buildMessage(ctx: RunnerAttachmentContext): string;
  deliver(ctx: RunnerAttachmentContext): Promise<RunnerAttachmentDeliveryResult>;
}

/**
 * Delivery goes through the shared runner send adapter so acceptance evidence comes from
 * the runner's structured observability signal — never from rendered TUI text.
 */
async function deliverViaRunnerInstruction(
  provider: RunnerAttachmentProvider,
  ctx: RunnerAttachmentContext,
): Promise<RunnerAttachmentDeliveryResult> {
  const message = provider.buildMessage(ctx);
  const accepted = await sendRunnerInstructionSafely(
    ctx.vars,
    ctx.target,
    provider.id,
    message,
    `[attachment:${provider.id}]`,
  );
  return accepted
    ? { status: 'delivered', detail: `Delivered ${ctx.filename} to ${provider.id}` }
    : {
        status: 'failed',
        detail: `${provider.id} did not accept the attachment prompt; retry when the composer is idle`,
      };
}

/**
 * Claude Code resolves `@<path>` file references and reads image files at that path.
 */
const claudeAttachmentProvider: RunnerAttachmentProvider = {
  id: 'claude',
  buildMessage: (ctx) => `Look at this image: @${ctx.storedPath}`,
  deliver: (ctx) => deliverViaRunnerInstruction(claudeAttachmentProvider, ctx),
};

/**
 * Codex CLI attaches a local image through its `view_image` tool when the prompt names an
 * absolute image path, so the plain path is the supported delivery interaction.
 */
const codexAttachmentProvider: RunnerAttachmentProvider = {
  id: 'codex',
  buildMessage: (ctx) => `View the image at ${ctx.storedPath}`,
  deliver: (ctx) => deliverViaRunnerInstruction(codexAttachmentProvider, ctx),
};

export const KNOWN_RUNNER_ATTACHMENT_PROVIDERS: Record<string, RunnerAttachmentProvider> = {
  claude: claudeAttachmentProvider,
  codex: codexAttachmentProvider,
};

export function getRunnerAttachmentProvider(
  runnerId?: string | null,
): RunnerAttachmentProvider | null {
  if (!runnerId) return null;
  return KNOWN_RUNNER_ATTACHMENT_PROVIDERS[normalizeRunner(runnerId)] ?? null;
}

export function runnerSupportsAttachments(runnerId?: string | null): boolean {
  return getRunnerAttachmentProvider(runnerId) !== null;
}

export function runnerAttachmentUnsupportedDetail(runnerId?: string | null): string {
  const runner = runnerId ? normalizeRunner(runnerId) : null;
  return runner
    ? `Runner ${runner} has no verified image attachment support`
    : 'No runner is bound to this terminal, so the image cannot be delivered';
}
