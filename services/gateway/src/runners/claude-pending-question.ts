import { isRecord } from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';

import { readClaudeProcessState } from './claude-process-observability.js';
import type { ObservabilityReading, SlotVars } from './observability-types.js';

/** Read native tool calls/results, never the rendered question menu. */
export function buildClaudeQuestionProbeCommand(sessionId: string, transcript: string): string {
  return `python3 - <<'PY'
import json, os
from pathlib import Path
session = ${JSON.stringify(sessionId)}
file = Path(${JSON.stringify(transcript)})
def unknown():
    print(json.dumps({'known': False}))
    raise SystemExit(0)
if file.name != session + '.jsonl':
    unknown()
try:
    with file.open('rb') as stream:
        before = os.fstat(stream.fileno())
        offset = max(0, before.st_size - 8 * 1024 * 1024)
        stream.seek(offset)
        data = stream.read(8 * 1024 * 1024 + 1)
        after = os.fstat(stream.fileno())
    current = file.stat()
except OSError:
    unknown()
identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
if identity(before) != identity(after) or identity(after) != identity(current) or not data.endswith(b'\\n'):
    unknown()
if offset:
    boundary = data.find(b'\\n')
    if boundary < 0:
        unknown()
    data = data[boundary + 1:]
pending = {}
matched = False
for line in data.splitlines():
    if not line.strip():
        continue
    try:
        row = json.loads(line)
    except (ValueError, UnicodeError):
        unknown()
    if not isinstance(row, dict):
        unknown()
    if row.get('sessionId') != session or row.get('isSidechain') is not False:
        continue
    kind = row.get('type')
    message = row.get('message')
    if kind not in ('assistant', 'user') or not isinstance(message, dict):
        continue
    matched = True
    content = message.get('content')
    blocks = content if isinstance(content, list) else []
    if kind == 'user':
        for block in blocks:
            if isinstance(block, dict) and block.get('type') == 'tool_result':
                pending.pop(block.get('tool_use_id'), None)
        # A later ordinary root prompt supersedes an abandoned question.
        if row.get('isMeta') is not True and (isinstance(content, str) or any(isinstance(b, dict) and b.get('type') == 'text' for b in blocks)):
            pending.clear()
        continue
    for block in blocks:
        if not isinstance(block, dict) or block.get('type') != 'tool_use' or block.get('name') != 'AskUserQuestion':
            continue
        tool = block.get('id')
        inputs = block.get('input')
        questions = inputs.get('questions') if isinstance(inputs, dict) else None
        if not isinstance(tool, str) or not tool or not isinstance(questions, list) or not questions:
            unknown()
        rendered = []
        for question in questions:
            if not isinstance(question, dict) or not isinstance(question.get('question'), str) or not question['question'].strip():
                unknown()
            lines = [question['question']]
            options = question.get('options', [])
            if not isinstance(options, list):
                unknown()
            for option in options:
                if not isinstance(option, dict) or not isinstance(option.get('label'), str):
                    unknown()
                detail = option.get('description', '')
                if not isinstance(detail, str):
                    unknown()
                lines.append('- ' + option['label'] + (': ' + detail if detail else ''))
            rendered.append('\\n'.join(lines))
        pending[tool] = '\\n\\n'.join(rendered)
if not matched:
    unknown()
print(json.dumps({'known': True, 'sessionId': session, 'observedAt': current.st_mtime_ns / 1000000, 'question': '\\n\\n'.join(pending.values()) or None}))
PY`;
}

interface QuestionReaders {
  process: typeof readClaudeProcessState;
  exec: typeof execOnSlot;
}

export async function readClaudePendingQuestion(
  vars: SlotVars,
  target: string,
  overrides: Partial<QuestionReaders> = {},
): Promise<ObservabilityReading<string | null> | null> {
  const source = { process: readClaudeProcessState, exec: execOnSlot, ...overrides };
  const native = await source.process(vars, target);
  if (!native) return null;
  const result = await source.exec(
    vars,
    buildClaudeQuestionProbeCommand(native.sessionId, native.sessionPath),
    { timeout: 10000, maxBuffer: 256 * 1024 },
  );
  if (result.exitCode !== 0) return null;
  const current = await source.process(vars, target);
  if (
    current?.sessionId !== native.sessionId ||
    current.processPid !== native.processPid ||
    current.sessionPath !== native.sessionPath
  )
    return null;
  const value: unknown = JSON.parse(result.stdout);
  if (
    !isRecord(value) ||
    value.known !== true ||
    value.sessionId !== native.sessionId ||
    typeof value.observedAt !== 'number' ||
    !Number.isFinite(value.observedAt) ||
    !(value.question === null || (typeof value.question === 'string' && value.question.trim()))
  )
    return null;
  return {
    value: value.question,
    observedAt: value.observedAt,
    sessionId: native.sessionId,
    source: 'signal',
    confidence: 'high',
  };
}
