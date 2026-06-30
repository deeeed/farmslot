import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { Events, type IntelligenceAction } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { getRun, updateRun } from '../runs/store.js';

import { redactToAllowlist } from './audit-fields.js';

const MAX_LINE_BYTES = 4096;
const MAX_TMUX_KEYS_CHARS = 2048;
const TRUNCATION_SUFFIX = '…[truncated]';
type Emit = (event: string, payload: unknown) => void;

export function intelligenceAuditDir(): string {
  return (
    process.env.FARMSLOT_INTELLIGENCE_AUDIT_DIR ??
    path.join(farmslotHome(), 'logs', 'intelligence-actions')
  );
}
export function intelligenceAuditPathForDate(date = new Date()): string {
  return path.join(intelligenceAuditDir(), `${date.toISOString().slice(0, 10)}.ndjson`);
}

function truncateTmuxKeys(action: IntelligenceAction): IntelligenceAction {
  const applied = action.appliedAction;
  const keys = applied?.tmuxKeys;
  if (!keys || keys.length <= MAX_TMUX_KEYS_CHARS) return action;
  return {
    ...action,
    appliedAction: {
      type: applied.type,
      ...(applied.stepName ? { stepName: applied.stepName } : {}),
      ...(applied.replayRunId ? { replayRunId: applied.replayRunId } : {}),
      tmuxKeys: keys.slice(0, MAX_TMUX_KEYS_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX,
    },
  };
}
function serializeBounded(action: IntelligenceAction): string {
  let redacted = redactToAllowlist(truncateTmuxKeys(action));
  let line = JSON.stringify(redacted);
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  if (redacted.appliedAction?.tmuxKeys) {
    redacted = {
      ...redacted,
      appliedAction: { ...redacted.appliedAction, tmuxKeys: TRUNCATION_SUFFIX },
    };
    line = JSON.stringify(redacted);
  }
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  redacted = { ...redacted, guards: redacted.guards.slice(0, 16) };
  line = JSON.stringify(redacted);
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  throw new Error(`intelligence audit line exceeds ${MAX_LINE_BYTES} bytes after redaction`);
}
export async function writeAuditRecord(
  action: IntelligenceAction,
  ctx: { runId: string; emit: Emit; now?: Date },
): Promise<void> {
  try {
    const dir = intelligenceAuditDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Re-check every write instead of caching so chmod drift flips the live
    // degraded flag immediately, matching ADR-031's degraded-audit gate.
    const mode = (await stat(dir)).mode & 0o777;
    if (mode !== 0o700)
      throw new Error(`intelligence audit directory mode is ${mode.toString(8)}; expected 700`);
    await appendFile(
      intelligenceAuditPathForDate(ctx.now),
      `${serializeBounded(action)}\n`,
      'utf8',
    );
    const run = getRun(ctx.runId);
    if (run && run.engineState?.intelligenceAuditDegraded === true) {
      const updated = updateRun(ctx.runId, {
        engineState: { ...(run.engineState ?? {}), intelligenceAuditDegraded: false },
      });
      ctx.emit(Events.RUN_UPDATED, { run: updated });
    }
  } catch (err) {
    const run = getRun(ctx.runId);
    if (run) {
      const updated = updateRun(ctx.runId, {
        engineState: { ...(run.engineState ?? {}), intelligenceAuditDegraded: true },
      });
      ctx.emit(Events.RUN_UPDATED, { run: updated });
    }
    console.warn(
      `[intel-audit] write_failed runId=${ctx.runId} reason=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
export const INTELLIGENCE_AUDIT_MAX_LINE_BYTES = MAX_LINE_BYTES;
export const INTELLIGENCE_AUDIT_TMUX_TRUNCATION_SUFFIX = TRUNCATION_SUFFIX;
