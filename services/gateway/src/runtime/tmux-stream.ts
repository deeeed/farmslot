// tmux-stream.ts — Poll tmux capture-pane for terminal data, stream to subscribed clients

import type { TerminalData } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote, tmuxSendTextCommand, tmuxShellSnippet } from '../core/tmux.js';
import { runnerPromptSubmitKey } from '../runners/registry.js';

export type TerminalDataHandler = (data: TerminalData) => void;

interface Subscription {
  slotId: string;
  session: string;
  handler: TerminalDataHandler;
  lastContent: string;
}

const subscriptions = new Map<string, Subscription[]>(); // subscription key -> handlers
let pollInterval: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 500;

export function subscribe(
  key: string,
  slotId: string,
  session: string,
  handler: TerminalDataHandler,
): void {
  const sub: Subscription = { slotId, session, handler, lastContent: '' };
  const existing = subscriptions.get(key) || [];
  existing.push(sub);
  subscriptions.set(key, existing);

  if (!pollInterval && subscriptions.size > 0) {
    startPolling();
  }
}

export function unsubscribe(key: string, handler: TerminalDataHandler): void {
  const subs = subscriptions.get(key);
  if (!subs) return;
  const filtered = subs.filter((s) => s.handler !== handler);
  if (filtered.length === 0) {
    subscriptions.delete(key);
  } else {
    subscriptions.set(key, filtered);
  }

  if (subscriptions.size === 0 && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

export function unsubscribeAll(handler: TerminalDataHandler): void {
  for (const [slotId, subs] of subscriptions) {
    const filtered = subs.filter((s) => s.handler !== handler);
    if (filtered.length === 0) {
      subscriptions.delete(slotId);
    } else {
      subscriptions.set(slotId, filtered);
    }
  }
  if (subscriptions.size === 0 && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function capturePane(slotId: string, session: string, lines?: number): Promise<string> {
  try {
    const vars = await loadSlotVars(slotId);
    const parts = ['capture-pane', '-t', shellQuote(session), '-p'];
    if (lines) {
      parts.push('-S', shellQuote(`-${lines}`));
    }
    const { stdout } = await execOnSlot(vars, tmuxShellSnippet(parts.join(' ')), { timeout: 5000 });
    return stdout;
  } catch (err) {
    // tmux capture-pane can fail when the session/pane is gone (slot released,
    // window closed); return empty to let the poll skip this cycle gracefully.
    console.warn(
      `[tmux-stream] capture-pane failed for ${slotId} target=${session}: ${(err as Error).message}`,
    );
    return '';
  }
}

function startPolling(): void {
  pollInterval = setInterval(async () => {
    const keys = [...subscriptions.keys()];
    await Promise.all(
      keys.map(async (key) => {
        const subs = subscriptions.get(key);
        if (!subs || subs.length === 0) return;

        const { slotId, session } = subs[0];
        const content = await capturePane(slotId, session);
        if (!content) return;

        // Diff: only send if content changed
        const lastContent = subs[0].lastContent;
        if (content === lastContent) return;

        const data: TerminalData = {
          slotId,
          data: content,
          timestamp: Date.now(),
        };

        for (const sub of subs) {
          sub.lastContent = content;
          sub.handler(data);
        }
      }),
    );
  }, POLL_MS);
}

export async function snapshot(slotId: string, session: string, lines = 200): Promise<string[]> {
  const content = await capturePane(slotId, session, lines);
  return content.split('\n');
}

export function buildSendKeysCommand(
  session: string,
  text: string,
  enter = true,
  runner?: string,
): string {
  // Raw operator PTY input omits runner identity and keeps normal Enter
  // semantics. Semantic agent steering supplies the resolved runner and uses
  // the shared runner capability.
  return enter
    ? tmuxSendTextCommand(session, text, {
        enter: true,
        submitKey: runner ? runnerPromptSubmitKey(runner) : 'Enter',
      })
    : tmuxSendTextCommand(session, text);
}

export async function sendKeys(
  slotId: string,
  session: string,
  text: string,
  enter = true,
  runner?: string,
): Promise<void> {
  const vars = await loadSlotVars(slotId);
  await execOnSlot(vars, buildSendKeysCommand(session, text, enter, runner), { timeout: 5000 });
}
