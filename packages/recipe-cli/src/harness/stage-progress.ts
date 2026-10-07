// stage-progress — the one renderer for setup stages (launch, prepare, doctor
// --fix). Each stage is a line on stderr, `[2/5] metro: bundling 61% (4,210/6,900
// modules), 1m42s`, repeated at least every 15 s while it runs, so a slow start
// and a hang read differently. A payload that stops changing gets a plain "no
// progress for 1m00s" line; it never fails the command. Stdout and every --json
// document stay as they were; --json-stream gets a `stage` event per line.

import type { StageHandle, StageProgress } from '@farmslot/adapter-sdk';

const HEARTBEAT_MS = 15_000;
const STALL_NOTICE_MS = 60_000;
// A child command's stage lines carry their own heartbeat, so the parent waits
// a little past it before speaking for a quiet child.
const FORWARD_GRACE_MS = 5_000;

/** A line from a child harness command that is itself a stage line. */
export const STAGE_LINE = /^\[\d+\/\d+\] /u;

export interface StageReporterOptions {
  // One finished line (default: stderr).
  write?(line: string): void;
  // The --json-stream `stage` event for that line.
  event?(fields: Record<string, unknown>): void;
  heartbeatMs?: number;
  // Default RECIPE_STAGE_STALL_NOTICE_MS, else 60 s.
  stallMs?: number;
}

export interface ReportedStage extends StageHandle {
  // A child command's own stage line, shown under this one: `[3/5] launch --verify › [2/5] metro: …`.
  forward(line: string): void;
}

export interface StageReporter {
  stage(name: string, position: { index: number; total: number }): ReportedStage;
  // Ends every stage still running: the command is over.
  close(status: 'done' | 'failed', detail?: string): void;
}

/** `20s`, `1m42s`, `1h03m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

// The payload as the event carries it; also what "changed" compares, so a
// percent moving within one whole number is not progress the line could show.
function progressFields(progress: StageProgress): Record<string, string | number> {
  const fields: Record<string, string | number | undefined> = {
    waitingFor: progress.waitingFor,
    message: progress.message,
    percent: progress.percent === undefined ? undefined : Math.floor(progress.percent),
    current: progress.current,
    totalCount: progress.total,
    unit: progress.unit,
    screen: progress.screen,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
}

const count = (value: number): string => value.toLocaleString('en-US');

/** `bundling 61% (4,210/6,900 modules)`, `waiting for unlock, page is #onboarding/welcome`. */
export function stageProgressText(progress: StageProgress): string {
  const { message, waitingFor, percent, current, total, unit, screen } = progress;
  const counts =
    current === undefined
      ? undefined
      : `(${count(current)}${total === undefined ? '' : `/${count(total)}`}${unit ? ` ${unit}` : ''})`;
  const head = [message, waitingFor && `waiting for ${waitingFor}`].filter(Boolean).join(', ');
  const measured = [head, percent === undefined ? undefined : `${Math.floor(percent)}%`, counts]
    .filter(Boolean)
    .join(' ');
  return [measured, screen && `page is ${screen}`].filter(Boolean).join(', ');
}

function stallNoticeMs(): number {
  const value = Number(process.env.RECIPE_STAGE_STALL_NOTICE_MS);
  return Number.isFinite(value) && value > 0 ? value : STALL_NOTICE_MS;
}

export function createStageReporter(options: StageReporterOptions = {}): StageReporter {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const stallMs = options.stallMs ?? stallNoticeMs();
  const open = new Set<ReportedStage>();

  return {
    stage(name, { index, total }) {
      const prefix = `[${index}/${total}] ${name}`;
      const startedAt = Date.now();
      let latest: StageProgress = {};
      let latestKey = '{}';
      let changedAt = startedAt;
      let timer: NodeJS.Timeout | undefined;
      let ended = false;

      const line = (text: string, status: string, fields: Record<string, unknown> = {}): void => {
        const elapsedMs = Date.now() - startedAt;
        write(`${prefix}: ${text}, ${formatElapsed(elapsedMs)}`);
        options.event?.({ stage: name, index, total, status, elapsedMs, ...fields });
      };
      const heartbeat = (): void => {
        const stalledMs = Date.now() - changedAt;
        const text = stageProgressText(latest);
        if (stalledMs >= stallMs) {
          const still = latest.screen ? `still on ${latest.screen}` : text && `still ${text}`;
          const notice = [`no progress for ${formatElapsed(stalledMs)}`, still].filter(Boolean);
          line(notice.join(', '), 'progress', { ...progressFields(latest), stalledMs });
        } else {
          line(text || 'running', 'progress', progressFields(latest));
        }
        schedule(heartbeatMs);
      };
      // Unref'd: feedback must never be what keeps the process alive.
      const schedule = (delayMs: number): void => {
        clearTimeout(timer);
        timer = setTimeout(heartbeat, delayMs);
        timer.unref();
      };
      const end = (status: 'done' | 'failed', detail?: string): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        open.delete(handle);
        line(detail ? `${status}, ${detail}` : status, status, detail ? { message: detail } : {});
      };

      const handle: ReportedStage = {
        progress(progress) {
          if (ended) return;
          const fields = progressFields(progress);
          const key = JSON.stringify(fields);
          // The same payload again is not progress; the heartbeat repeats it.
          if (key === latestKey) return;
          latest = { ...progress };
          latestKey = key;
          changedAt = Date.now();
          line(stageProgressText(latest) || 'running', 'progress', fields);
          schedule(heartbeatMs);
        },
        done: (detail) => end('done', detail),
        failed: (detail) => end('failed', detail),
        forward(childLine) {
          if (ended) return;
          write(`${prefix} › ${childLine}`);
          if (!childLine.includes('no progress for')) changedAt = Date.now();
          schedule(heartbeatMs + FORWARD_GRACE_MS);
        },
      };
      open.add(handle);
      line('started', 'start');
      schedule(heartbeatMs);
      return handle;
    },
    close(status, detail) {
      for (const stage of [...open]) {
        if (status === 'done') stage.done(detail);
        else stage.failed(detail);
      }
    },
  };
}
