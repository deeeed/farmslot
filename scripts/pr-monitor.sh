#!/usr/bin/env bash
# pr-monitor.sh — PR status formatter with actionable recommendations.
#
# Fetches PR data from the gateway via pr-status.sh (which delegates to
# `farmslot pr list/status --json`) and formats it as a human table or JSON.
# Recommendation logic lives in the gateway (computePRRecommendation in
# @farmslot/protocol); this script is a pure formatter — no local rule engine.
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

# -- Fetch PR data via pr-status.sh (delegates to farmslot pr list/status) --
PR_JSON=$(bash "${SCRIPT_DIR}/pr-status.sh" --json "${PASS_THROUGH_ARGS[@]+"${PASS_THROUGH_ARGS[@]}"}" 2>/dev/null)

# -- Format output from gateway PRStatus JSON --------------------------------
_PR_JSON="$PR_JSON" _FORMAT="$FORMAT" _SCRIPT_DIR="$SCRIPT_DIR" python3 << 'PYEOF'
import json, os, sys
from datetime import datetime, timezone

pr_json = os.environ['_PR_JSON']
fmt = os.environ['_FORMAT']
script_dir = os.environ['_SCRIPT_DIR']

data = json.loads(pr_json)

# farmslot pr list → { "prs": [...] }
# farmslot pr status N → { "pr": {...} }
prs_raw = data.get('prs') or ([data['pr']] if 'pr' in data else [])

if not prs_raw:
    if fmt == 'json':
        json.dump({'checked_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                   'prs': [], 'message': 'No active PRs found'}, sys.stdout, indent=2)
        print()
    else:
        print('No active PRs found.')
    sys.exit(0)

# -- Apply display rules per PR (matches bash pr-monitor.sh first-match semantics) --
# Recommendation strings come from the gateway; detail/action are formatter-specific.
# Intentional diff vs. TS: we re-check merged/prState before workerActive so
# MERGED/CLOSED display correctly even on the rare race where worker is still alive.
results = []
for pr in sorted(prs_raw, key=lambda x: x.get('pr', 0)):
    pr_num          = pr.get('pr', '?')
    slot            = pr.get('slot') or '-'
    merged          = pr.get('merged', False)
    pr_state        = pr.get('prState', 'OPEN')
    merge_conflict  = pr.get('mergeConflict', False)
    any_failed      = pr.get('anyFailed', False)
    all_passed      = pr.get('allPassed', False)
    worker_active   = pr.get('workerActive', False)
    recommendation  = pr.get('recommendation', 'IN_REVIEW')
    check_summary   = pr.get('checkSummary', {})
    failed_names    = pr.get('failedNames', [])
    actionable      = pr.get('actionableBotComments', [])
    actionable_count = len(actionable)

    release_cmd = f'bash {script_dir}/release-slot.sh {slot} --keep-warm --reset' if slot != '-' else None

    # First-match display rules (bash-compatible ordering, recommendation from gateway)
    if merged or pr_state == 'MERGED':
        display = 'MERGED'
        detail  = 'PR merged.'
        action  = release_cmd
    elif pr_state == 'CLOSED':
        display = 'CLOSED'
        detail  = 'PR closed without merge.'
        action  = release_cmd
    elif merge_conflict and worker_active:
        display = 'MERGE CONFLICT (worker active)'
        detail  = 'PR has merge conflicts. Worker session alive — nudge to merge main.'
        action  = None
    elif merge_conflict and not worker_active:
        display = 'MERGE CONFLICT (action needed)'
        detail  = 'PR has merge conflicts. Worker session dead.'
        action  = f'/farm-rebase {pr_num}'
    elif recommendation in ('READY', 'WAITING_FOR_MERGE') and not merge_conflict and not any_failed and actionable_count == 0:
        p = check_summary.get('passed', 0)
        t = check_summary.get('total', 0)
        display = recommendation  # preserve WAITING_FOR_MERGE distinction
        detail  = f'CI: {p}/{t} pass. No unresolved comments. Ready for human review.'
        action  = release_cmd
    elif actionable_count > 0 and worker_active:
        labels  = sorted(set(a.get('label', 'bot') for a in actionable))
        display = 'COMMENTS (worker active)'
        detail  = f'{", ".join(labels)}: {actionable_count} unresolved comment(s). Worker session alive.'
        action  = None
    elif actionable_count > 0 and not worker_active:
        labels  = sorted(set(a.get('label', 'bot') for a in actionable))
        display = 'COMMENTS (action needed)'
        detail  = f'{", ".join(labels)}: {actionable_count} unresolved comment(s). Worker session dead.'
        action  = f'/farm-pr-complete {pr_num}'
    elif any_failed and worker_active:
        display = 'CI FAILED (worker active)'
        detail  = f'Failed: {", ".join(failed_names)}. Worker session alive.'
        action  = None
    elif any_failed and not worker_active:
        display = 'CI FAILED (action needed)'
        detail  = f'Failed: {", ".join(failed_names)}. Worker session dead.'
        action  = None  # manual intervention
    elif recommendation == 'WORKING':
        p    = check_summary.get('passed', 0)
        t    = check_summary.get('total', 0)
        display = 'WORKING'
        detail  = f'Worker session alive. CI: {p}/{t} pass.'
        action  = None
    else:
        p    = check_summary.get('passed', 0)
        t    = check_summary.get('total', 0)
        pend = check_summary.get('pending', 0)
        display = 'PENDING'
        detail  = f'CI: {p}/{t} pass, {pend} pending.'
        if not actionable_count:
            detail += ' No comments yet.'
        action = None

    results.append({
        'pr':             pr_num,
        'slot':           slot,
        'recommendation': display,
        'detail':         detail,
        'action':         action,
        'checkSummary':   check_summary,
        'failedNames':    failed_names,
        'actionableComments': actionable_count,
        'prState':        pr_state,
        'merged':         merged,
        'workerActive':   worker_active,
        # Historical schema keys (pre-port consumers parse these names).
        'summary':        check_summary,
        'failed_names':   failed_names,
        'actionable_comments': actionable_count,
        'pr_state':       pr_state,
        # session was the tmux session name; the gateway payload does not carry
        # it, so honesty over fabrication: null unless the payload provides one.
        'session':        pr.get('session'),
        # historical string enum, not a boolean
        'session_alive':  ('true' if worker_active else 'false') if 'workerActive' in pr else 'unknown',
    })

# -- Output --
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

if fmt == 'json':
    out = {'checked_at': now, 'prs': results}
    json.dump(out, sys.stdout, indent=2)
    print()
else:
    use_color = sys.stdout.isatty()

    def c(code, text):
        if not use_color:
            return text
        return f'\033[{code}m{text}\033[0m'

    def rec_color(rec):
        if rec in ('READY', 'MERGED', 'WAITING_FOR_MERGE'):
            return c('1;32', rec)
        if rec == 'CLOSED':
            return c('2', rec)
        if 'CONFLICT' in rec or 'action needed' in rec:
            return c('1;31', rec)
        if 'worker active' in rec:
            return c('0;33', rec)
        if rec == 'PENDING':
            return c('0;33', rec)
        return rec

    print(f'PR Monitor — {now}')
    print('=' * 64)

    for r in results:
        pr_num = r['pr']
        slot   = r['slot']
        rec    = r['recommendation']
        detail = r['detail']
        action = r.get('action')

        print(f'PR #{pr_num}  [{slot}]  {rec_color(rec)}')
        print(f'  {detail}')
        if action:
            print(f'  → {action}')
        print()

    print('=' * 64)
PYEOF
