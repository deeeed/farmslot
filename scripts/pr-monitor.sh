#!/usr/bin/env bash
# pr-monitor.sh — Deterministic PR status monitor with actionable recommendations.
#
# Scans all farm PRs (from ci-watch slots + active working slots) via pr-status.sh,
# applies rules to determine recommendations, outputs human-readable table or JSON.
#
# Usage:
#   pr-monitor.sh               # Human table (default if tty)
#   pr-monitor.sh --json        # Machine-readable JSON
#   pr-monitor.sh --pr 27460    # Check specific PR(s)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# -- Options ---------------------------------------------------------------
PASS_THROUGH_ARGS=()
FORMAT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)  FORMAT="json"; shift ;;
    --human) FORMAT="human"; shift ;;
    --pr)
      PASS_THROUGH_ARGS+=("--pr")
      shift
      while [[ $# -gt 0 && ! "$1" =~ ^-- ]]; do
        PASS_THROUGH_ARGS+=("$1")
        shift
      done
      ;;
    --since) PASS_THROUGH_ARGS+=("--since" "$2"); shift 2 ;;
    -h|--help)
      echo "Usage: pr-monitor.sh [--pr <N>...] [--since <ISO>] [--json|--human]"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Default format: json if piped, human if tty
if [ -z "$FORMAT" ]; then
  if [ -t 1 ]; then FORMAT="human"; else FORMAT="json"; fi
fi

# -- Fetch CI data via pr-status.sh ----------------------------------------
CI_JSON=$(bash "${SCRIPT_DIR}/pr-status.sh" --json "${PASS_THROUGH_ARGS[@]+"${PASS_THROUGH_ARGS[@]}"}" 2>/dev/null)

# -- Apply rules and generate output ---------------------------------------
_CI_JSON="$CI_JSON" _FORMAT="$FORMAT" _SCRIPT_DIR="$SCRIPT_DIR" python3 << 'PYEOF'
import json, os, sys
from datetime import datetime, timezone

ci_json = os.environ['_CI_JSON']
fmt = os.environ['_FORMAT']
script_dir = os.environ['_SCRIPT_DIR']

data = json.loads(ci_json)
prs = data.get('prs', [])
checked_at = data.get('checked_at', '')

if not prs:
    if fmt == 'json':
        json.dump({'checked_at': checked_at, 'prs': [], 'message': 'No active PRs found'}, sys.stdout, indent=2)
        print()
    else:
        print('No active PRs found.')
    sys.exit(0)

# -- Apply rules per PR (first match wins) --
results = []
for pr in sorted(prs, key=lambda x: x.get('pr', 0)):
    pr_num = pr.get('pr', '?')
    slot = pr.get('slot') or '-'
    session = pr.get('session') or ''
    session_alive = pr.get('session_alive', 'unknown')
    is_alive = session_alive == 'true'
    pr_state = pr.get('pr_state', '')
    merged = pr.get('merged', False)
    all_passed = pr.get('all_passed', False)
    any_failed = pr.get('any_failed', False)
    summary = pr.get('summary', {})
    merge_conflict = pr.get('merge_conflict', False)
    actionable = pr.get('actionable_bot_comments', [])
    has_actionable = len(actionable) > 0
    failed_names = pr.get('failed_names', [])

    # First-match rule evaluation
    if merged:
        recommendation = 'MERGED'
        detail = 'PR merged.'
        action = f'bash {script_dir}/release-slot.sh {slot} --keep-warm --reset' if slot != '-' else None
    elif pr_state == 'CLOSED':
        recommendation = 'CLOSED'
        detail = 'PR closed without merge.'
        action = f'bash {script_dir}/release-slot.sh {slot} --keep-warm --reset' if slot != '-' else None
    elif merge_conflict and is_alive:
        recommendation = 'MERGE CONFLICT (worker active)'
        detail = 'PR has merge conflicts. Worker session alive — nudge to merge main.'
        action = None
    elif merge_conflict and not is_alive:
        recommendation = 'MERGE CONFLICT (action needed)'
        detail = 'PR has merge conflicts. Worker session dead.'
        action = f'/farm-rebase {pr_num}'
    elif all_passed and not has_actionable:
        recommendation = 'READY'
        p = summary.get('passed', 0)
        t = summary.get('total', 0)
        detail = f'CI: {p}/{t} pass. No unresolved comments. Ready for human review.'
        action = f'bash {script_dir}/release-slot.sh {slot} --keep-warm --reset' if slot != '-' else None
    elif has_actionable and is_alive:
        labels = set(a.get('label', 'bot') for a in actionable)
        detail = f'{", ".join(labels)}: {len(actionable)} unresolved comment(s). Worker session alive.'
        recommendation = 'COMMENTS (worker active)'
        action = None
    elif has_actionable and not is_alive:
        labels = set(a.get('label', 'bot') for a in actionable)
        detail = f'{", ".join(labels)}: {len(actionable)} unresolved comment(s). Worker session dead.'
        recommendation = 'COMMENTS (action needed)'
        action = f'/farm-pr-complete {pr_num}'
    elif any_failed and is_alive:
        recommendation = 'CI FAILED (worker active)'
        detail = f'Failed: {", ".join(failed_names)}. Worker session alive.'
        action = None
    elif any_failed and not is_alive:
        recommendation = 'CI FAILED (action needed)'
        detail = f'Failed: {", ".join(failed_names)}. Worker session dead.'
        action = None  # manual intervention
    else:
        p = summary.get('passed', 0)
        t = summary.get('total', 0)
        pend = summary.get('pending', 0)
        detail = f'CI: {p}/{t} pass, {pend} pending.'
        if not has_actionable:
            detail += ' No comments yet.'
        recommendation = 'PENDING'
        action = None

    results.append({
        'pr': pr_num,
        'slot': slot,
        'session': session,
        'session_alive': session_alive,
        'recommendation': recommendation,
        'detail': detail,
        'action': action,
        'summary': summary,
        'failed_names': failed_names,
        'actionable_comments': len(actionable),
        'pr_state': pr_state,
        'merged': merged,
    })

# -- Output --
if fmt == 'json':
    out = {'checked_at': checked_at, 'prs': results}
    json.dump(out, sys.stdout, indent=2)
    print()
else:
    use_color = sys.stdout.isatty()

    def c(code, text):
        if not use_color:
            return text
        return f'\033[{code}m{text}\033[0m'

    def rec_color(rec):
        if rec in ('READY', 'MERGED'):
            return c('1;32', rec)
        if rec == 'CLOSED':
            return c('2', rec)
        if rec == 'MERGE CONFLICT':
            return c('1;31', rec)
        if 'action needed' in rec:
            return c('1;31', rec)
        if 'worker active' in rec:
            return c('0;33', rec)
        if rec == 'PENDING':
            return c('0;33', rec)
        return rec

    now = checked_at or datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    print(f'PR Monitor \u2014 {now}')
    print('=' * 64)

    for r in results:
        pr_num = r['pr']
        slot = r['slot']
        rec = r['recommendation']
        detail = r['detail']
        action = r.get('action')

        print(f'PR #{pr_num}  [{slot}]  {rec_color(rec)}')
        print(f'  {detail}')
        if action:
            print(f'  \u2192 {action}')
        print()

    print('=' * 64)
PYEOF
