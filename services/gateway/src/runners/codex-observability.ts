import path from 'node:path';

import { resolveProjectRuntimeDir } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { resolveTmuxPaneId, shellQuote } from '../core/tmux.js';

import { claudeHookObservability } from './claude-observability.js';
import { observedAtFromRecord, readRunnerPaneObservabilityState } from './observability-files.js';
import type { RunnerObservability, SlotVars } from './observability-types.js';

type CodexPromptProbe =
  | { status: 'matched'; observedAt: number; turnId: string }
  | { status: 'not-found' | 'unavailable' | 'identity-mismatch' };

export function parseCodexPromptProbe(raw: string): CodexPromptProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    typeof parsed.observedAt === 'number' &&
    typeof parsed.turnId === 'string'
  ) {
    return { status: 'matched', observedAt: parsed.observedAt, turnId: parsed.turnId };
  }
  if (
    parsed.status === 'not-found' ||
    parsed.status === 'unavailable' ||
    parsed.status === 'identity-mismatch'
  ) {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex prompt probe: ${raw}`);
}

export function buildCodexPromptProbeCommand(
  sessionId: string,
  sessionPath: string,
  promptText: string,
  sinceMs: number,
): string {
  return `
python3 - <<'PY'
import json
from datetime import datetime
from pathlib import Path

session_id = ${JSON.stringify(sessionId)}
session_path = Path(${JSON.stringify(sessionPath)})
expected_prompt = ${JSON.stringify(promptText)}
since_ms = ${Math.floor(sinceMs)}

if not session_path.is_file():
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

try:
    with session_path.open('rb') as handle:
        first = json.loads(handle.readline().decode('utf-8'))
        if (
            first.get('type') != 'session_meta'
            or first.get('payload', {}).get('id') != session_id
        ):
            print(json.dumps({'status': 'identity-mismatch'}))
            raise SystemExit(0)
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

def timestamp_ms(value):
    if not isinstance(value, str) or not value:
        return None
    normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return int(parsed.timestamp() * 1000)

def reverse_lines(handle, block_size=65536):
    handle.seek(0, 2)
    position = handle.tell()
    remainder = b''
    while position:
        count = min(block_size, position)
        position -= count
        handle.seek(position)
        parts = (handle.read(count) + remainder).split(b'\\n')
        remainder = parts[0]
        for line in reversed(parts[1:]):
            if line:
                yield line
    if remainder:
        yield remainder

# Find the newest exact prompt in the send window, then keep walking backward
# to the native task_started boundary that owns it. Codex steering messages are
# intentionally part of the active turn; safe-send waits for an unrelated busy
# turn to finish before submitting a new prompt. No fixed byte tail may sever
# the prompt from its owning boundary on a large rollout.
matched_at = None
try:
    with session_path.open('rb') as handle:
        for raw_line in reverse_lines(handle):
            try:
                record = json.loads(raw_line.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            payload = record.get('payload', {})
            observed_at = timestamp_ms(record.get('timestamp'))
            if matched_at is None:
                if observed_at is not None and observed_at < since_ms:
                    break
                if (
                    record.get('type') != 'response_item'
                    or payload.get('type') != 'message'
                    or payload.get('role') != 'user'
                ):
                    continue
                content = payload.get('content')
                if not isinstance(content, list):
                    continue
                parts = [
                    item.get('text') for item in content
                    if isinstance(item, dict) and item.get('type') == 'input_text'
                ]
                if (
                    parts
                    and all(isinstance(part, str) for part in parts)
                    and '\\n'.join(parts) == expected_prompt
                    and observed_at is not None
                    and observed_at >= since_ms
                ):
                    matched_at = observed_at
                continue
            if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
                turn_id = payload.get('turn_id')
                if isinstance(turn_id, str) and turn_id:
                    print(json.dumps({
                        'status': 'matched',
                        'observedAt': matched_at,
                        'turnId': turn_id,
                    }))
                    raise SystemExit(0)
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

print(json.dumps({'status': 'not-found'}))
PY`;
}

type CodexTurnStateProbe =
  | { status: 'matched'; state: 'active' | 'idle'; observedAt: number; turnId: string }
  | { status: 'unavailable' | 'identity-mismatch' };

export function parseCodexTurnStateProbe(raw: string): CodexTurnStateProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    (parsed.state === 'active' || parsed.state === 'idle') &&
    typeof parsed.observedAt === 'number' &&
    typeof parsed.turnId === 'string'
  ) {
    return {
      status: 'matched',
      state: parsed.state,
      observedAt: parsed.observedAt,
      turnId: parsed.turnId,
    };
  }
  if (parsed.status === 'unavailable' || parsed.status === 'identity-mismatch') {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex turn-state probe: ${raw}`);
}

/** Read the latest native turn boundary backwards without a fixed tail limit. */
export function buildCodexTurnStateProbeCommand(sessionId: string, sessionPath: string): string {
  return `
python3 - <<'PY'
import json
from datetime import datetime
from pathlib import Path

session_id = ${JSON.stringify(sessionId)}
session_path = Path(${JSON.stringify(sessionPath)})

def timestamp_ms(value):
    if not isinstance(value, str) or not value:
        return None
    normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return int(parsed.timestamp() * 1000)

def reverse_lines(handle, block_size=65536):
    handle.seek(0, 2)
    position = handle.tell()
    remainder = b''
    while position:
        count = min(block_size, position)
        position -= count
        handle.seek(position)
        parts = (handle.read(count) + remainder).split(b'\\n')
        remainder = parts[0]
        for line in reversed(parts[1:]):
            if line:
                yield line
    if remainder:
        yield remainder

try:
    with session_path.open('rb') as handle:
        first = json.loads(handle.readline().decode('utf-8'))
        if first.get('type') != 'session_meta' or first.get('payload', {}).get('id') != session_id:
            print(json.dumps({'status': 'identity-mismatch'}))
            raise SystemExit(0)
        for raw_line in reverse_lines(handle):
            try:
                record = json.loads(raw_line.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if record.get('type') != 'event_msg':
                continue
            payload = record.get('payload', {})
            event_type = payload.get('type')
            turn_id = payload.get('turn_id')
            observed_at = timestamp_ms(record.get('timestamp'))
            if not isinstance(turn_id, str) or not turn_id or observed_at is None:
                continue
            if event_type == 'task_started':
                print(json.dumps({
                    'status': 'matched', 'state': 'active',
                    'observedAt': observed_at, 'turnId': turn_id,
                }))
                raise SystemExit(0)
            if event_type in ('task_complete', 'turn_aborted'):
                print(json.dumps({
                    'status': 'matched', 'state': 'idle',
                    'observedAt': observed_at, 'turnId': turn_id,
                }))
                raise SystemExit(0)
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

print(json.dumps({'status': 'unavailable'}))
PY`;
}

export function buildCodexSessionIdProbeCommand(sessionPath: string): string {
  return `
python3 - <<'PY'
import json
from pathlib import Path

session_path = Path(${JSON.stringify(sessionPath)})
try:
    with session_path.open() as handle:
        first = json.loads(handle.readline())
    session_id = first.get('payload', {}).get('id') if first.get('type') == 'session_meta' else None
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    session_id = None
print(json.dumps({'sessionId': session_id if isinstance(session_id, str) else None}))
PY`;
}

type CodexSessionBindingProbe =
  | { status: 'matched'; sessionId: string; sessionPath: string }
  | { status: 'unavailable' | 'identity-mismatch' };

export function parseCodexSessionBindingProbe(raw: string): CodexSessionBindingProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    typeof parsed.sessionId === 'string' &&
    typeof parsed.sessionPath === 'string'
  ) {
    return {
      status: 'matched',
      sessionId: parsed.sessionId,
      sessionPath: parsed.sessionPath,
    };
  }
  if (parsed.status === 'unavailable' || parsed.status === 'identity-mismatch') {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex session binding probe: ${raw}`);
}

type CodexNativeBindingProbe =
  | { status: 'matched'; sessionId: string; sessionPath: string; observedAt: number }
  | { status: 'unavailable' | 'identity-mismatch' | 'ambiguous' };

export function parseCodexNativeBindingProbe(raw: string): CodexNativeBindingProbe {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.status === 'matched' &&
    typeof parsed.sessionId === 'string' &&
    typeof parsed.sessionPath === 'string' &&
    typeof parsed.observedAt === 'number'
  ) {
    return {
      status: 'matched',
      sessionId: parsed.sessionId,
      sessionPath: parsed.sessionPath,
      observedAt: parsed.observedAt,
    };
  }
  if (
    parsed.status === 'unavailable' ||
    parsed.status === 'identity-mismatch' ||
    parsed.status === 'ambiguous'
  ) {
    return { status: parsed.status };
  }
  throw new Error(`Invalid Codex native binding probe: ${raw}`);
}

/**
 * Files a process currently holds open, one path per `n`-prefixed line.
 *
 * This is the PRIMARY ownership evidence: a process holding the exact rollout
 * file open is a kernel fact about that pid, with no display formatting in the
 * way. `ps -o args=` flattens argv into one display string, so a value
 * containing spaces (`--config 'note = <uuid>'`) can masquerade as the
 * positional session id — argv can therefore reject, but never certify.
 */
export function buildRunnerOpenFileProbeCommand(pid: string): string {
  // macOS ships lsof in /usr/sbin, which is not on every non-login PATH. Same
  // candidate-resolution shape the tmux helper uses; a missing binary yields a
  // non-zero exit, which the caller reports as indeterminate, never a denial.
  return [
    'LSOF_BIN="$(command -v lsof 2>/dev/null || true)"',
    '[ -n "$LSOF_BIN" ] || [ ! -x /usr/sbin/lsof ] || LSOF_BIN=/usr/sbin/lsof',
    '[ -n "$LSOF_BIN" ] || { echo "lsof not found" >&2; exit 127; }',
    `"$LSOF_BIN" -p ${shellQuote(pid)} -F n 2>/dev/null`,
  ].join('; ');
}

/** Canonical paths held open by the probed process. */
export function parseOpenFilePaths(lsofOutput: string): string[] {
  return lsofOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('n') && line.length > 1)
    .map((line) => line.slice(1));
}

/**
 * Read one process's argv, for proving which session a live runner is resuming.
 * `ps -o args=` is a structured process read, not pane text.
 */
export function buildRunnerProcessArgvCommand(pid: string): string {
  return `ps -p ${shellQuote(pid)} -o args= 2>/dev/null`;
}

/**
 * `codex resume` flags, transcribed once from `codex resume --help`. Never
 * parsed from help text at runtime.
 *
 * Positional detection depends on knowing which flags eat the next token, and
 * that list cannot be guessed: an unknown flag makes the first positional
 * ambiguous, so the parser refuses to answer rather than certify the wrong id.
 */
const CODEX_RESUME_VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
]);

const CODEX_RESUME_BOOLEAN_FLAGS = new Set([
  '--all',
  '--include-non-interactive',
  '--strict-config',
  '--oss',
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--no-alt-screen',
  '-h',
  '--help',
  '-V',
  '--version',
]);

/** `-i, --image <FILE>...` is variadic, so the positional after it is unknowable. */
const CODEX_RESUME_VARIADIC_FLAGS = new Set(['-i', '--image']);

export type CodexResumeArgvVerdict =
  | { kind: 'resumes' }
  | { kind: 'other-session' }
  | { kind: 'indeterminate'; reason: string };

/**
 * Decide whether this argv shows codex resuming exactly
 * {@link expectedSessionId}.
 *
 * Codex spells a reopen as `codex … resume [OPTIONS] [SESSION_ID] [PROMPT]`, so
 * the id is the FIRST POSITIONAL after `resume`. Finding it means skipping
 * options, which means knowing which options consume a value. Anything not in
 * the transcribed tables — a new flag, an alias, a variadic `--image` — makes
 * that impossible, and the answer is `indeterminate`, never a certification.
 */
export function codexResumeArgvVerdict(
  argv: string,
  expectedSessionId: string,
): CodexResumeArgvVerdict {
  const trimmedId = expectedSessionId.trim();
  if (!trimmedId) return { kind: 'indeterminate', reason: 'expected session id is empty' };
  const args = argv.trim().split(/\s+/).filter(Boolean);
  const resumeAt = args.indexOf('resume');
  if (resumeAt === -1) return { kind: 'other-session' };
  for (let i = resumeAt + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      // First positional after `resume` is the session argument; nothing later counts.
      return arg === trimmedId ? { kind: 'resumes' } : { kind: 'other-session' };
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (CODEX_RESUME_VARIADIC_FLAGS.has(flag)) {
      return {
        kind: 'indeterminate',
        reason: `variadic codex flag ${flag} makes the session argument ambiguous`,
      };
    }
    if (flag === '--last') {
      // `--last` picks the session by recency and shifts the positional to
      // PROMPT, so argv cannot name the session at all.
      return {
        kind: 'indeterminate',
        reason: '--last resumes by recency, so the positional is a prompt, not a session id',
      };
    }
    if (CODEX_RESUME_BOOLEAN_FLAGS.has(flag)) continue;
    if (CODEX_RESUME_VALUE_FLAGS.has(flag)) {
      // `--flag=value` carries its value inline and eats no following token.
      if (!arg.includes('=')) i += 1;
      continue;
    }
    return { kind: 'indeterminate', reason: `unrecognized codex flag ${flag}` };
  }
  return { kind: 'other-session' };
}

/** Convenience wrapper for callers that only need the positive answer. */
export function codexArgvResumesSession(argv: string, expectedSessionId: string): boolean {
  return codexResumeArgvVerdict(argv, expectedSessionId).kind === 'resumes';
}

export function buildCodexNativeBindingProbeCommand(options: {
  repo: string;
  isolatedSessionsRoot: string;
  globalSessionsRoot?: string;
  observedNotBeforeMs: number;
  preferred?: { sessionId: string; sessionPath: string };
}): string {
  return `
python3 - <<'PY'
import json
import os
from pathlib import Path

repo = os.path.realpath(${JSON.stringify(options.repo)})
isolated_root = Path(${JSON.stringify(options.isolatedSessionsRoot)})
global_root = Path(${JSON.stringify(options.globalSessionsRoot ?? '')}) if ${options.globalSessionsRoot ? 'True' : 'False'} else Path.home() / '.codex' / 'sessions'
not_before_ms = ${Math.floor(options.observedNotBeforeMs)}
preferred_id = ${options.preferred ? JSON.stringify(options.preferred.sessionId) : 'None'}
preferred_path = ${options.preferred ? JSON.stringify(options.preferred.sessionPath) : 'None'}

def candidate(path):
    try:
        canonical = os.path.realpath(path)
        observed_at = int(os.stat(canonical).st_mtime * 1000)
        if observed_at < not_before_ms:
            return None
        with open(canonical) as handle:
            first = json.loads(handle.readline())
        if first.get('type') != 'session_meta':
            return None
        payload = first.get('payload', {})
        session_id = payload.get('id')
        cwd = payload.get('cwd')
        if not isinstance(session_id, str) or not session_id:
            return None
        if not isinstance(cwd, str) or os.path.realpath(cwd) != repo:
            return None
        return {'sessionId': session_id, 'sessionPath': canonical, 'observedAt': observed_at}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None

if preferred_id is not None and preferred_path is not None:
    preferred = candidate(preferred_path)
    if preferred is None or preferred['sessionId'] != preferred_id:
        print(json.dumps({'status': 'identity-mismatch'}))
        raise SystemExit(0)
    print(json.dumps({'status': 'matched', **preferred}))
    raise SystemExit(0)

matches = []
seen = set()
for root in (isolated_root, global_root):
    if not root.is_dir():
        continue
    paths = sorted(root.rglob('*.jsonl'), key=lambda item: item.stat().st_mtime, reverse=True)
    for path in paths[:400]:
        item = candidate(path)
        if item is None or item['sessionPath'] in seen:
            continue
        seen.add(item['sessionPath'])
        matches.append(item)

if len(matches) == 1:
    print(json.dumps({'status': 'matched', **matches[0]}))
elif len(matches) > 1:
    print(json.dumps({'status': 'ambiguous'}))
else:
    print(json.dumps({'status': 'unavailable'}))
PY`;
}

export function buildCodexSessionBindingProbeCommand(
  sessionPath: string,
  persistedSessionId?: string,
): string {
  return `
python3 - <<'PY'
import json
import os
from pathlib import Path

requested_path = Path(${JSON.stringify(sessionPath)})
persisted_session_id = ${persistedSessionId === undefined ? 'None' : JSON.stringify(persistedSessionId)}
try:
    session_path = Path(os.path.realpath(requested_path))
    with session_path.open() as handle:
        first = json.loads(handle.readline())
    session_id = first.get('payload', {}).get('id') if first.get('type') == 'session_meta' else None
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

if not isinstance(session_id, str) or not session_id:
    print(json.dumps({'status': 'unavailable'}))
    raise SystemExit(0)

# Before native Codex ids were read from session_meta, Farmslot persisted the
# rollout filename (minus .jsonl). Accept exactly that historical format, then
# upgrade both id and path to the current native/canonical binding.
legacy_session_id = requested_path.name
if legacy_session_id.endswith('.jsonl'):
    legacy_session_id = legacy_session_id[:-len('.jsonl')]
if persisted_session_id is not None and persisted_session_id not in (session_id, legacy_session_id):
    print(json.dumps({'status': 'identity-mismatch'}))
    raise SystemExit(0)

print(json.dumps({
    'status': 'matched',
    'sessionId': session_id,
    'sessionPath': str(session_path),
}))
PY`;
}

async function probeCodexSessionBinding(
  vars: SlotVars,
  sessionPath: string,
  persistedSessionId?: string,
): Promise<CodexSessionBindingProbe> {
  const result = await execOnSlot(
    vars,
    buildCodexSessionBindingProbeCommand(sessionPath, persistedSessionId),
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) return { status: 'unavailable' };
  return parseCodexSessionBindingProbe(result.stdout.trim());
}

async function resolveCodexPaneBinding(vars: SlotVars, target: string) {
  const paneId = await resolveTmuxPaneId(vars, target);
  if (!paneId) return null;
  const paneState = await readRunnerPaneObservabilityState(vars, paneId);
  const sessionId = paneState?.session_id;
  const sessionPath = paneState?.transcript_path;
  return sessionId && sessionPath ? { sessionId, sessionPath } : null;
}

async function readCodexNativeTurnState(vars: SlotVars, sessionId: string, sessionPath: string) {
  const result = await execOnSlot(vars, buildCodexTurnStateProbeCommand(sessionId, sessionPath), {
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return null;
  const probe = parseCodexTurnStateProbe(result.stdout.trim());
  return probe.status === 'matched'
    ? {
        value: probe.state,
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: probe.observedAt,
        sessionId,
        turnToken: `${sessionId}:${probe.turnId}`,
      }
    : null;
}

async function readCodexPromptAcceptance(
  vars: SlotVars,
  sessionId: string,
  sessionPath: string,
  promptText: string,
  sinceMs: number,
) {
  const result = await execOnSlot(
    vars,
    buildCodexPromptProbeCommand(sessionId, sessionPath, promptText, sinceMs),
    { timeout: 10_000 },
  );
  if (result.exitCode !== 0) return null;
  const probe = parseCodexPromptProbe(result.stdout.trim());
  return probe.status === 'matched'
    ? {
        value: true,
        source: 'signal' as const,
        confidence: 'high' as const,
        observedAt: probe.observedAt,
        exactPromptMatch: true,
        sessionId,
        turnToken: `${sessionId}:${probe.turnId}`,
      }
    : null;
}

export const codexSessionObservability: RunnerObservability = {
  ...claudeHookObservability,
  promptAcceptanceMode: 'native-text',
  async getSessionBinding(vars, target, observedNotBeforeMs = 0) {
    const paneId = await resolveTmuxPaneId(vars, target);
    if (!paneId) return null;
    const paneState = await readRunnerPaneObservabilityState(vars, paneId);
    const paneObservedAt = paneState ? observedAtFromRecord(paneState) : null;
    const preferred =
      paneObservedAt != null &&
      paneObservedAt >= observedNotBeforeMs &&
      paneState?.session_id?.trim() &&
      paneState.transcript_path?.trim()
        ? {
            sessionId: paneState.session_id.trim(),
            sessionPath: paneState.transcript_path.trim(),
          }
        : undefined;
    const runtimeDir = await resolveProjectRuntimeDir(vars.projectName);
    const result = await execOnSlot(
      vars,
      buildCodexNativeBindingProbeCommand({
        repo: vars.remoteRepo,
        isolatedSessionsRoot: path.posix.join(
          vars.remoteRepo,
          runtimeDir,
          'codex-home',
          'sessions',
        ),
        observedNotBeforeMs,
        ...(preferred ? { preferred } : {}),
      }),
      { timeout: 10_000 },
    );
    if (result.exitCode !== 0) return null;
    const probe = parseCodexNativeBindingProbe(result.stdout.trim());
    return probe.status === 'matched'
      ? {
          sessionId: probe.sessionId,
          sessionPath: probe.sessionPath,
          observedAt: probe.observedAt,
        }
      : null;
  },
  async getTurnState(vars, target, expectedTurnToken) {
    const binding = await resolveCodexPaneBinding(vars, target);
    if (!binding) return null;
    if (expectedTurnToken && !expectedTurnToken.startsWith(`${binding.sessionId}:`)) return null;
    return readCodexNativeTurnState(vars, binding.sessionId, binding.sessionPath);
  },
  async resolveSessionId(vars, sessionPath) {
    const result = await execOnSlot(vars, buildCodexSessionIdProbeCommand(sessionPath), {
      timeout: 10_000,
    });
    if (result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout.trim()) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : null;
  },
  async verifyResumedSessionBinding(vars, runnerPid, expectedSessionId, expectedSessionPath) {
    if (!expectedSessionPath?.trim()) {
      return {
        ok: false,
        indeterminate: true,
        reason: 'no canonical session path was supplied to confirm the open handle',
      };
    }

    // Certification is the open handle alone: this pid, already proven to be a
    // runner process under the pane, holding that exact rollout file open.
    //
    // argv is NOT a gate in either direction. `ps -o args=` flattens argv into
    // one display string, so a value containing spaces (`--config 'note = x'`,
    // `-C '/path with spaces'`) both hides the real session argument and can
    // present a fake one — it can therefore falsely reject a valid resume just
    // as easily as it can falsely accept. It is recorded for diagnosis only.
    let argvVerdict;
    const argvResult = await execOnSlot(vars, buildRunnerProcessArgvCommand(runnerPid), {
      timeout: 10_000,
    });
    if (argvResult.exitCode === 0 && argvResult.stdout.trim()) {
      argvVerdict = codexResumeArgvVerdict(argvResult.stdout.trim(), expectedSessionId).kind;
    }

    // Codex opens the rollout on write, so allow a few samples.
    let lastReason = `runner process ${runnerPid} does not hold ${expectedSessionPath} open`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const open = await execOnSlot(vars, buildRunnerOpenFileProbeCommand(runnerPid), {
        timeout: 10_000,
      });
      if (open.exitCode !== 0) {
        lastReason = `open-file probe for ${runnerPid} is unavailable`;
        continue;
      }
      if (parseOpenFilePaths(open.stdout).includes(expectedSessionPath)) {
        return { ok: true, ...(argvVerdict ? { argvVerdict } : {}) };
      }
    }
    // Not proven, and not proven absent: the handle may simply not be open yet.
    return {
      ok: false,
      indeterminate: true,
      reason: lastReason,
      ...(argvVerdict ? { argvVerdict } : {}),
    };
  },

  async normalizeRetainedSessionBinding(vars, binding) {
    const probe = await probeCodexSessionBinding(vars, binding.sessionPath, binding.sessionId);
    return probe.status === 'matched'
      ? { sessionId: probe.sessionId, sessionPath: probe.sessionPath }
      : null;
  },
  async promptAccepted(vars, target, promptDigest, sinceMs, paneRetired, promptText) {
    if (!promptText) return null;
    const binding = await resolveCodexPaneBinding(vars, target);
    const nativeReading = binding
      ? await readCodexPromptAcceptance(
          vars,
          binding.sessionId,
          binding.sessionPath,
          promptText,
          sinceMs,
        )
      : null;
    if (nativeReading) return nativeReading;
    // Native rollout history is authoritative when available. Exact Codex
    // UserPromptSubmit hooks remain a delivery fallback when the native file
    // is temporarily unreadable or its binding has not appeared yet; their
    // timestamp token is deliberately omitted because native turn state uses
    // Codex turn ids and the two token domains must never be compared.
    const hookReading = await claudeHookObservability.promptAccepted(
      vars,
      target,
      promptDigest,
      sinceMs,
      paneRetired,
      promptText,
    );
    if (!hookReading) return null;
    const { turnToken: _hookTurnToken, ...fallback } = hookReading;
    return fallback;
  },
  async promptAcceptedInSession(vars, _target, sessionId, sessionPath, promptText, sinceMs) {
    return readCodexPromptAcceptance(vars, sessionId, sessionPath, promptText, sinceMs);
  },
};
