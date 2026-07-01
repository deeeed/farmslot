#!/bin/bash
# session-usage.sh — Token usage tracking for worker runner sessions
#
# Usage:
#   bash scripts/session-usage.sh <slot-id> snapshot
#   bash scripts/session-usage.sh <slot-id> report
#   bash scripts/session-usage.sh <slot-id> total

set -euo pipefail

SLOT_ID="${1:?Usage: session-usage.sh <slot-id> <snapshot|report|total>}"
ACTION="${2:?Usage: session-usage.sh <slot-id> <snapshot|report|total>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
POOL_DIR="${FARMSLOT_POOL_DIR:-${PROJECT_DIR}/pool}"
source "${SCRIPT_DIR}/lib/slot-common.sh"
load_slot_vars "$SLOT_ID"

python3 - "$REMOTE_REPO" "$SLOT_ID" "$ACTION" <<'PY'
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote

repo = sys.argv[1]
slot_id = sys.argv[2]
action = sys.argv[3]
home = Path.home()
forced_path = os.environ.get('RUNNER_SESSION_PATH')
forced_runner = os.environ.get('RUNNER_SESSION_RUNNER')


def grok_repo_key(repo_path: str) -> str:
    try:
        return os.path.realpath(repo_path)
    except Exception:
        return os.path.abspath(repo_path)


def grok_cwd_matches(summary_cwd, repo_path: str) -> bool:
    return repo_path_matches(summary_cwd, repo_path)


def repo_path_matches(session_path, repo_path: str) -> bool:
    if not session_path:
        return False
    repo_key = grok_repo_key(repo_path)
    try:
        return os.path.realpath(session_path) == repo_key
    except Exception:
        return session_path == repo_path or session_path == repo_key

CLAUDE_PRICING = {
    'claude-opus-4-6':   {'input': 15.0, 'output': 75.0, 'cache_write': 18.75, 'cache_read': 1.50},
    'claude-sonnet-4-6': {'input': 3.0,  'output': 15.0, 'cache_write': 3.75,  'cache_read': 0.30},
    'claude-haiku-4-5':  {'input': 0.80, 'output': 4.0,  'cache_write': 1.0,   'cache_read': 0.08},
}

# Conservative/optional estimates for Codex/OpenAI models. If model doesn't match,
# we simply omit cost_usd rather than inventing a value.
OPENAI_PRICING = {
    'gpt-5.4': {'input': 5.0, 'output': 15.0},
}


def empty_totals():
    return {
        'input_tokens': 0,
        'output_tokens': 0,
        'cache_creation': 0,
        'cache_read': 0,
        'reasoning_output_tokens': 0,
        'turns': 0,
        'model': 'unknown',
        'total_tokens': 0,
        'cost_usd': None,
    }


def safe_json_lines(path: Path):
    with path.open() as f:
        for line in f:
            try:
                yield json.loads(line)
            except Exception:
                # Runner transcript files may contain partial/truncated JSONL when the
                # process is still writing. Ignore malformed lines and use complete records.
                continue


def latest_claude_session(repo_path: str):
    session_dir = home / '.claude' / 'projects' / repo_path.replace('/', '-')
    if not session_dir.is_dir():
        return None, None
    files = sorted(session_dir.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return None, None
    session_file = files[0]
    snap = session_dir / f'.usage-snapshot-{slot_id}.json'
    return session_file, snap


def latest_codex_session(repo_path: str):
    sessions_root = home / '.codex' / 'sessions'
    if not sessions_root.is_dir():
        return None, None
    candidates = []
    for path in sessions_root.rglob('*.jsonl'):
        try:
            with path.open() as f:
                first = json.loads(next(f))
            if first.get('type') == 'session_meta' and repo_path_matches(first.get('payload', {}).get('cwd'), repo_path):
                candidates.append(path)
        except Exception:
            # Session discovery scans third-party runner state; unreadable or malformed
            # files are not Farmslot sessions and should not fail the whole status call.
            continue
    if not candidates:
        return None, None
    session_file = max(candidates, key=lambda p: p.stat().st_mtime)
    snap = session_file.parent / f'.usage-snapshot-{slot_id}.json'
    return session_file, snap


def grok_sessions_dirs(repo_path: str):
    keys = {quote(repo_path, safe=''), quote(grok_repo_key(repo_path), safe='')}
    dirs = []
    for key in keys:
        candidate = home / '.grok' / 'sessions' / key
        if candidate.is_dir():
            dirs.append(candidate)
    return dirs


def latest_grok_session(repo_path: str):
    candidates = []
    seen = set()
    for sessions_dir in grok_sessions_dirs(repo_path):
        for summary_path in sessions_dir.glob('*/summary.json'):
            try:
                summary = json.loads(summary_path.read_text())
                if grok_cwd_matches(summary.get('info', {}).get('cwd'), repo_path):
                    parent = summary_path.parent
                    if parent in seen:
                        continue
                    seen.add(parent)
                    candidates.append(parent)
            except Exception:
                # Grok may leave partial summary files while the TUI is writing; skip those.
                continue
    if not candidates:
        return None, None
    session_dir = max(candidates, key=lambda p: p.stat().st_mtime)
    snap = session_dir / f'.usage-snapshot-{slot_id}.json'
    return session_dir, snap


def choose_session(repo_path: str):
    choices = []
    for runner, finder in [('claude', latest_claude_session), ('codex', latest_codex_session), ('grok', latest_grok_session)]:
        session_path, snap = finder(repo_path)
        if session_path:
            choices.append((runner, session_path, snap, session_path.stat().st_mtime))
    if not choices:
        raise SystemExit(f'ERROR: No Claude, Codex, or Grok session found for {repo_path}')
    choices.sort(key=lambda item: item[3], reverse=True)
    return choices[0][:3]


def summarize_claude(path: Path):
    totals = empty_totals()
    for obj in safe_json_lines(path):
        if obj.get('type') == 'assistant':
            msg = obj.get('message') or {}
            if totals['model'] == 'unknown' and msg.get('model'):
                totals['model'] = msg['model']
            usage = msg.get('usage') or {}
            if usage:
                totals['turns'] += 1
                totals['input_tokens'] += usage.get('input_tokens', 0)
                totals['output_tokens'] += usage.get('output_tokens', 0)
                totals['cache_creation'] += usage.get('cache_creation_input_tokens', 0)
                totals['cache_read'] += usage.get('cache_read_input_tokens', 0)
    total_input = totals['input_tokens'] + totals['cache_creation'] + totals['cache_read']
    totals['total_tokens'] = total_input + totals['output_tokens']
    prices = next((p for k, p in CLAUDE_PRICING.items() if totals['model'] != 'unknown' and k in totals['model']), None)
    if prices:
        totals['cost_usd'] = (
            totals['input_tokens'] * prices['input'] / 1_000_000
            + totals['output_tokens'] * prices['output'] / 1_000_000
            + totals['cache_creation'] * prices['cache_write'] / 1_000_000
            + totals['cache_read'] * prices['cache_read'] / 1_000_000
        )
    return totals


def codex_usage_total(usage):
    if usage.get('total_tokens') is not None:
        return usage.get('total_tokens', 0)
    # Codex/OpenAI usage details treat cached input as part of input_tokens and
    # reasoning output as part of output_tokens; do not double-count detail fields.
    return usage.get('input_tokens', 0) + usage.get('output_tokens', 0)


def summarize_codex(path: Path):
    totals = empty_totals()
    latest_usage = None
    for obj in safe_json_lines(path):
        typ = obj.get('type')
        payload = obj.get('payload') or {}
        if typ == 'session_meta':
            totals['model'] = payload.get('model') or payload.get('model_slug') or totals['model']
        elif typ == 'turn_context':
            totals['model'] = payload.get('model') or totals['model']
        elif typ == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'assistant':
            totals['turns'] += 1
        elif typ == 'turn.completed' and obj.get('usage'):
            latest_usage = obj.get('usage') or latest_usage
            totals['turns'] += 1
        elif typ == 'event_msg' and payload.get('type') == 'token_count':
            info = payload.get('info') or {}
            latest_usage = info.get('total_token_usage') or info.get('last_token_usage') or latest_usage
    if latest_usage:
        totals['input_tokens'] = latest_usage.get('input_tokens', 0)
        totals['output_tokens'] = latest_usage.get('output_tokens', 0)
        totals['cache_read'] = latest_usage.get('cached_input_tokens', 0)
        totals['reasoning_output_tokens'] = latest_usage.get('reasoning_output_tokens', 0)
        totals['total_tokens'] = codex_usage_total(latest_usage)
    prices = next((p for k, p in OPENAI_PRICING.items() if totals['model'] != 'unknown' and totals['model'].startswith(k)), None)
    if prices:
        totals['cost_usd'] = (
            totals['input_tokens'] * prices['input'] / 1_000_000
            + totals['output_tokens'] * prices['output'] / 1_000_000
        )
    return totals


def summarize_grok(path: Path):
    session_dir = path if path.is_dir() else path.parent
    summary_path = session_dir / 'summary.json'
    if not summary_path.exists():
        raise SystemExit(f'ERROR: Grok session summary not found at {summary_path}')
    summary = json.loads(summary_path.read_text())
    session_id = summary.get('info', {}).get('id') or session_dir.name
    totals = empty_totals()
    totals['model'] = summary.get('current_model_id') or 'unknown'
    logs_path = home / '.grok' / 'logs' / 'unified.jsonl'
    if not logs_path.exists():
        raise SystemExit(f'ERROR: Grok unified log not found at {logs_path}')
    for obj in safe_json_lines(logs_path):
        if obj.get('sid') != session_id or obj.get('msg') != 'shell.turn.inference_done':
            continue
        ctx = obj.get('ctx') or {}
        totals['turns'] += 1
        totals['input_tokens'] += ctx.get('prompt_tokens', 0)
        totals['output_tokens'] += ctx.get('completion_tokens', 0)
        totals['cache_read'] += ctx.get('cached_prompt_tokens', 0)
        totals['reasoning_output_tokens'] += ctx.get('reasoning_tokens', 0)
    if totals['turns'] == 0:
        raise SystemExit(f'ERROR: No Grok inference usage found for session {session_id}')
    # Grok reports cached_prompt_tokens/reasoning_tokens as detail fields inside
    # prompt_tokens/completion_tokens, so total is prompt + completion only.
    totals['total_tokens'] = totals['input_tokens'] + totals['output_tokens']
    return totals


def summarize_cursor(path: Path):
    try:
        obj = json.loads(path.read_text())
    except Exception as exc:
        raise SystemExit(f'ERROR: Cursor usage requires headless --output-format json stdout: {exc}')
    usage = obj.get('usage') or {}
    if not usage:
        raise SystemExit('ERROR: Cursor transcript does not contain token usage; capture --output-format json stdout')
    totals = empty_totals()
    totals['model'] = obj.get('model') or 'unknown'
    totals['turns'] = 1
    totals['input_tokens'] = usage.get('inputTokens', 0)
    totals['output_tokens'] = usage.get('outputTokens', 0)
    totals['cache_read'] = usage.get('cacheReadTokens', 0)
    totals['cache_creation'] = usage.get('cacheWriteTokens', 0)
    totals['total_tokens'] = usage.get('totalTokens') or (totals['input_tokens'] + totals['output_tokens'])
    return totals


def summarize(runner: str, path: Path):
    if runner == 'claude':
        return summarize_claude(path)
    if runner == 'codex':
        return summarize_codex(path)
    if runner == 'grok':
        return summarize_grok(path)
    if runner == 'cursor':
        return summarize_cursor(path)
    raise SystemExit(f'ERROR: Unsupported runner for usage extraction: {runner}')


def session_name(path: Path):
    return path.name if path.is_dir() else path.stem


def session_line_count(path: Path):
    if path.is_file():
        return sum(1 for _ in path.open())
    jsonl_lines = 0
    for child in path.glob('*.jsonl'):
        jsonl_lines += sum(1 for _ in child.open())
    return jsonl_lines


def print_report(runner: str, session_file: Path, from_snapshot=None):
    current = summarize(runner, session_file)
    if from_snapshot is None:
        print(f'Session:  {session_name(session_file)}')
        print(f'Runner:   {runner}')
        print(f'Lines:    {session_line_count(session_file)}')
        print('---')
        base = None
    else:
        print(f'Session:  {session_name(session_file)}')
        print(f'Runner:   {runner}')
        print(f'Snapshot: {from_snapshot["session"]}')
        print('---')
        base = from_snapshot['totals']

    if base:
        diff = {k: current.get(k, 0) for k in current.keys()}
        for key in ['turns','input_tokens','output_tokens','cache_creation','cache_read','reasoning_output_tokens','total_tokens']:
            diff[key] = current.get(key, 0) - base.get(key, 0)
        if current.get('cost_usd') is not None and base.get('cost_usd') is not None:
            diff['cost_usd'] = current['cost_usd'] - base['cost_usd']
        else:
            diff['cost_usd'] = None
        diff['model'] = current.get('model', 'unknown')
        current = diff

    print(f'turns={current.get("turns", 0)}')
    print(f'model={current.get("model", "unknown")}')
    print(f'input_tokens={current.get("input_tokens", 0)}')
    print(f'output_tokens={current.get("output_tokens", 0)}')
    print(f'cache_creation={current.get("cache_creation", 0)}')
    print(f'cache_read={current.get("cache_read", 0)}')
    if 'reasoning_output_tokens' in current:
        print(f'reasoning_output_tokens={current.get("reasoning_output_tokens", 0)}')
    print(f'total_tokens={current.get("total_tokens", 0)}')
    if current.get('cost_usd') is not None:
        print(f'cost_usd={current["cost_usd"]:.4f}')


if forced_path:
    session_file = Path(forced_path)
    runner = forced_runner or ('claude' if '.claude/' in forced_path else 'codex')
    snapshot_file = session_file.parent / f'.usage-snapshot-{slot_id}.json'
else:
    runner, session_file, snapshot_file = choose_session(repo)

if action == 'snapshot':
    snapshot_file.write_text(json.dumps({
        'runner': runner,
        'session': session_name(session_file),
        'path': str(session_file),
        'totals': summarize(runner, session_file),
    }))
    print(f'Snapshot saved: {session_name(session_file)}')
elif action == 'report':
    if not snapshot_file.exists():
        raise SystemExit("ERROR: No snapshot found. Run 'snapshot' before delivering the prompt.")
    snap = json.loads(snapshot_file.read_text())
    print_report(runner, session_file, snap)
elif action == 'total':
    print_report(runner, session_file)
else:
    raise SystemExit(f'Unknown action: {action}')
PY
