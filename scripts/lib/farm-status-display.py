#!/usr/bin/env python3
"""Display farm status from JSON cache.

Usage: farm-status-display.py <status-json> <script-dir>

Reads .farm-status.json and renders a colored, properly-aligned table
that adapts to terminal width.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone

# ── Args ─────────────────────────────────────────────────────────────
if len(sys.argv) < 3:
    print("Usage: farm-status-display.py <status-json> <script-dir>", file=sys.stderr)
    sys.exit(1)

status_file = sys.argv[1]
script_dir = sys.argv[2]

with open(status_file) as f:
    data = json.load(f)

slots = data.get("slots", [])
checked_at = data.get("checked_at", "")

if not slots:
    print("No slots in status file.")
    sys.exit(1)

# ── Colors ───────────────────────────────────────────────────────────
use_color = sys.stdout.isatty()


def c(code, text):
    if not use_color:
        return text
    return f"\033[{code}m{text}\033[0m"


def green(t):
    return c("0;32", t)


def red(t):
    return c("0;31", t)


def yellow(t):
    return c("0;33", t)


def dim(t):
    return c("2", t)


def bold(t):
    return c("1", t)


# ── Colorize values ─────────────────────────────────────────────────
def color_status(val, ok_vals=("OK", "LOCAL"), warn_vals=(), fail_vals=("FAIL",)):
    if val in ok_vals:
        return green(val)
    if val in fail_vals:
        return red(val)
    if val in ("OFF",):
        return dim(val)
    if val == "-":
        return dim(val)
    # Handle prefixed values like emu:OK, sim:OFF
    if ":" in val:
        prefix, suffix = val.split(":", 1)
        if suffix == "OK":
            return prefix + ":" + green(suffix)
        if suffix == "OFF":
            return dim(val)
        if suffix == "FAIL":
            return prefix + ":" + red(suffix)
        return prefix + ":" + yellow(suffix)
    return yellow(val)


def color_cdp(val):
    if val == "Wallet":
        return green(val)
    if val == "FAIL":
        return red(val)
    if val == "OFF":
        return dim(val)
    if val == "-":
        return dim(val)
    return yellow(val)


def color_agent(val):
    if val == "idle":
        return green(val)
    if val == "working":
        return yellow(val)
    if val in ("no-tmux", "-"):
        return dim(val)
    return val


def color_branch(val):
    if val in ("main", "master"):
        return dim(val)
    if val == "-":
        return dim(val)
    return val


def color_lifecycle(val):
    if val == "ready":
        return green(val)
    if val in ("working", "dispatching"):
        return yellow(val)
    if val in ("done",):
        return green(val)
    if val == "recycling":
        return yellow(val)
    if val == "ci-watch":
        return c("0;36", val)  # cyan
    if val == "custom":
        return c("0;36", val)  # cyan
    if val in ("disabled", "released"):
        return dim(val)
    if val in ("-", "None", None):
        return dim("-")
    return val


# ── Build rows ───────────────────────────────────────────────────────
columns = ["SLOT", "MACHINE", "SSH", "DEV", "DEVSRV", "CDP", "FIX", "DEVICE", "PORT", "BRANCH", "AGENT", "LIFECYCLE", "TASK"]

# Compute max width for each column from data
rows_plain = []  # plain text (for width calc)
rows_color = []  # colored text (for display)

for s in slots:
    branch = s["branch"]
    task = s.get("task") or s.get("task_id") or "-"
    device = s.get("device") or "-"
    lifecycle = s.get("lifecycle") or "-"

    # Append runner:model to task when slot is working
    runner = s.get("runner")
    model = s.get("model")
    if lifecycle in ("working", "dispatching") and task != "-" and runner:
        runner_label = f"{runner}:{model}" if model else runner
        task = f"{task} ({runner_label})"

    row_p = [
        s["slot"],
        s["machine"],
        s["ssh"],
        s["dev"],
        s.get("devserver", s.get("metro", "-")),
        s["cdp"],
        s["fixtures"],
        device,
        str(s.get("metro_port", "-")),
        branch,
        s["agent"],
        lifecycle,
        task,
    ]

    is_disabled = s.get("mode", "dispatch") == "disabled"

    if is_disabled:
        row_c = [dim(v) for v in row_p]
    else:
        devsrv = s.get("devserver", s.get("metro", "-"))
        row_c = [
            s["slot"],
            s["machine"],
            color_status(s["ssh"]),
            color_status(s["dev"]),
            color_status(devsrv),
            color_cdp(s["cdp"]),
            color_status(s["fixtures"], ok_vals=("OK",), fail_vals=()),
            device,
            str(s.get("metro_port", "-")),
            color_branch(branch),
            color_agent(s["agent"]),
            color_lifecycle(lifecycle),
            dim(task) if task == "-" else task,
        ]

    rows_plain.append(row_p)
    rows_color.append(row_c)

# ── Dynamic column widths ────────────────────────────────────────────
term_width = shutil.get_terminal_size((120, 24)).columns
col_gap = 2

# Start with header widths
widths = [len(h) for h in columns]

# Expand to fit data
for row in rows_plain:
    for i, val in enumerate(row):
        widths[i] = max(widths[i], len(val))

# If total width exceeds terminal, truncate BRANCH and DEVICE first
total = sum(widths) + col_gap * (len(widths) - 1)
if total > term_width:
    # Shrink BRANCH (index 9) first
    overflow = total - term_width
    branch_idx = 9
    min_branch = 8
    shrink = min(overflow, widths[branch_idx] - min_branch)
    if shrink > 0:
        widths[branch_idx] -= shrink
        overflow -= shrink

    # Then shrink DEVICE (index 7)
    if overflow > 0:
        device_idx = 7
        min_device = 8
        shrink = min(overflow, widths[device_idx] - min_device)
        if shrink > 0:
            widths[device_idx] -= shrink


def truncate(val, width):
    if len(val) <= width:
        return val
    return val[: width - 2] + ".."


def pad(plain_val, colored_val, width):
    """Pad colored_val to fill width, using plain_val length for calculation."""
    visible_len = len(plain_val)
    padding = max(0, width - visible_len)
    return colored_val + " " * padding


# ── Timestamp ────────────────────────────────────────────────────────
age_str = ""
if checked_at:
    try:
        checked_dt = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
        age = datetime.now(timezone.utc) - checked_dt
        secs = int(age.total_seconds())
        if secs < 60:
            age_str = f"{secs}s ago"
        elif secs < 3600:
            age_str = f"{secs // 60}m ago"
        else:
            age_str = f"{secs // 3600}h{(secs % 3600) // 60}m ago"
    except (ValueError, TypeError):
        age_str = checked_at

# ── Print table ──────────────────────────────────────────────────────
separator = bold("=" * min(sum(widths) + col_gap * (len(widths) - 1), term_width))
gap = " " * col_gap

# Header
print(f"\n{bold('Farm Status')}" + (f"  {dim(age_str)}" if age_str else ""))
print(separator)

header = gap.join(bold(h.ljust(widths[i])) for i, h in enumerate(columns))
print(header)

# Rows
for row_idx, (rp, rc) in enumerate(zip(rows_plain, rows_color)):
    parts = []
    for i in range(len(columns)):
        plain_trunc = truncate(rp[i], widths[i])
        # Re-colorize truncated value
        if plain_trunc != rp[i]:
            colored_trunc = rc[i]
            # Strip existing color and re-truncate
            colored_trunc = truncate(rp[i], widths[i])
            # Re-apply color
            if i == 2:
                colored_trunc = color_status(plain_trunc)
            elif i == 3:
                colored_trunc = color_status(plain_trunc)
            elif i == 4:
                colored_trunc = color_status(plain_trunc)
            elif i == 5:
                colored_trunc = color_cdp(plain_trunc)
            elif i == 6:
                colored_trunc = color_status(plain_trunc, ok_vals=("OK",), fail_vals=())
            elif i == 9:
                colored_trunc = color_branch(plain_trunc)
            elif i == 10:
                colored_trunc = color_agent(plain_trunc)
            elif i == 11:
                colored_trunc = color_lifecycle(plain_trunc)
            elif i == 12:
                colored_trunc = dim(plain_trunc) if plain_trunc == "-" else plain_trunc
        else:
            colored_trunc = rc[i]

        parts.append(pad(plain_trunc, colored_trunc, widths[i]))

    print(gap.join(parts))

print(separator)

# ── Summary ──────────────────────────────────────────────────────────
total = len(slots)
disabled = sum(1 for s in slots if s.get("mode", "dispatch") == "disabled")
custom = sum(1 for s in slots if s.get("mode") == "custom")
dispatch_ok = sum(1 for s in slots if s.get("dispatchable"))
working = sum(1 for s in slots if s.get("agent") == "working")
active_slots = [s for s in slots if s.get("mode", "dispatch") != "disabled"]
stale = sum(1 for s in active_slots if s.get("fixtures") not in ("OK", "-"))
unreachable = sum(1 for s in active_slots if s.get("ssh") not in ("OK", "LOCAL"))

parts = [
    f"Dispatchable: {green(str(dispatch_ok))}/{total}",
    f"Working: {yellow(str(working))}",
    f"Fixtures stale: {yellow(str(stale))}",
    f"Unreachable: {red(str(unreachable))}",
]
if custom:
    parts.append(f"Custom: {c('0;36', str(custom))}")
if disabled:
    parts.append(f"Disabled: {dim(str(disabled))}")
print("  ".join(parts))

# ── Next steps ───────────────────────────────────────────────────────
hints_dispatch = []
hints_prepare = []
hints_monitor = []
hints_recycle = []

for s in slots:
    mode = s.get("mode", "dispatch")
    if mode == "disabled":
        continue
    sid = s["slot"]
    infra_ok = s.get("dispatchable", False)
    fix_ok = s.get("fixtures") == "OK"
    ssh_ok = s.get("ssh") in ("OK", "LOCAL")
    agent = s.get("agent", "")
    lifecycle = s.get("lifecycle", "ready")

    if mode == "custom":
        continue  # custom slots handled separately for sync only
    if lifecycle == "working":
        hints_monitor.append(sid)
    elif lifecycle in ("done",):
        hints_recycle.append(sid)
    elif lifecycle == "released":
        hints_prepare.append(sid)
    elif infra_ok and fix_ok:
        hints_dispatch.append(sid)
    elif ssh_ok and agent != "working":
        hints_prepare.append(sid)

farm_status = f"{script_dir}/farm-status.sh"

if hints_dispatch:
    print(f"\n{green('Ready to dispatch:')}  {dim(str(len(hints_dispatch)) + ' slot(s)')}")
    for sid in hints_dispatch:
        print(f"  farmslot run create --ticket <ref> --project <project> --slot {sid}")

if hints_monitor:
    print(f"\n{yellow('Monitor (working):')}  {dim(str(len(hints_monitor)) + ' slot(s)')}")
    for sid in hints_monitor:
        print(f"  {script_dir}/monitor-slot.sh {sid}")
        print(f"  farmslot slot release {sid} --keep-warm  {dim('# reset + re-prepare for next task')}")
        print(f"  farmslot slot release {sid}  {dim('# full teardown (stop Metro + device)')}")

if hints_recycle:
    print(f"\n{yellow('Recycle (done):')}  {dim(str(len(hints_recycle)) + ' slot(s)')}")
    if len(hints_recycle) > 1:
        print(f"  {farm_status} --recycle-all")
    else:
        for sid in hints_recycle:
            print(f"  farmslot slot release {sid} --keep-warm  {dim('# reset + re-prepare')}")
            print(f"  farmslot slot release {sid}  {dim('# full teardown')}")

if hints_prepare:
    print(f"\n{yellow('Prepare (not ready):')}  {dim(str(len(hints_prepare)) + ' slot(s)')}")
    if len(hints_prepare) > 1:
        print(f"  {farm_status} --prepare-all")
    else:
        for sid in hints_prepare:
            print(f"  farmslot slot prepare {sid}")

# Sync hint — separate from prepare, based on stale fixtures (includes personal slots)
hints_sync = [s["slot"] for s in slots if s.get("mode", "dispatch") != "disabled"
              and s.get("ssh") in ("OK", "LOCAL")
              and s.get("fixtures") not in ("OK", "-")]
if hints_sync:
    print(f"\n{yellow('Sync fixtures (stale):')}  {dim(str(len(hints_sync)) + ' slot(s)')}")
    if len(hints_sync) > 1:
        print(f"  {farm_status} --sync-all")
    else:
        for sid in hints_sync:
            print(f"  {script_dir}/sync-fixtures.sh --slot {sid}")

hints_prwatch = [s for s in slots if s.get("lifecycle") == "ci-watch" and s.get("mode", "dispatch") != "disabled"]
if hints_prwatch:
    print(f"\n{c('0;36', 'CI watch:')}  {dim(str(len(hints_prwatch)) + ' slot(s)')}")
    for s in hints_prwatch:
        pr = s.get("pr_number", "?")
        print(f"  {s['slot']}  PR #{pr}")
    print(f"  {script_dir}/pr-monitor.sh")

if not hints_dispatch and not hints_prepare and not hints_monitor and not hints_recycle and unreachable > 0:
    print(f"\n{red('All reachable slots have issues. Check SSH connectivity.')}")

# ── Working slots detail ──────────────────────────────────────────
working_slots = [s for s in slots if s.get("lifecycle") in ("working", "dispatching")]
if working_slots:
    print(f"\n{bold('Active Tasks')}")
    print(bold("─" * min(80, term_width)))

    for s in working_slots:
        sid = s["slot"]
        task = s.get("task") or s.get("task_id") or "-"
        runner = s.get("runner") or "?"
        model_name = s.get("model") or "?"
        dispatched = s.get("dispatched_at", "")

        # Elapsed time
        elapsed_str = ""
        if dispatched:
            try:
                dt = datetime.fromisoformat(dispatched.replace("Z", "+00:00"))
                elapsed = datetime.now(timezone.utc) - dt
                mins = int(elapsed.total_seconds()) // 60
                if mins < 60:
                    elapsed_str = f"{mins}m"
                else:
                    elapsed_str = f"{mins // 60}h{mins % 60}m"
            except (ValueError, TypeError):
                pass

        # Token usage
        usage_data = {}
        for action in ("report", "total"):
            try:
                result = subprocess.run(
                    ["bash", f"{script_dir}/session-usage.sh", sid, action],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        if "=" in line:
                            k, v = line.split("=", 1)
                            usage_data[k] = v
                    break
            except Exception:
                pass

        turns = usage_data.get("turns", "?")
        output_tokens = usage_data.get("output_tokens", "?")
        total_tokens = usage_data.get("total_tokens", "?")
        cost = usage_data.get("cost_usd", "?")

        def fmt_tokens(val):
            if val == "?":
                return val
            try:
                n = int(val)
                if n >= 1_000_000:
                    return f"{n / 1_000_000:.1f}M"
                if n >= 1_000:
                    return f"{n / 1_000:.1f}k"
                return str(n)
            except ValueError:
                return val

        output_tokens = fmt_tokens(output_tokens)
        total_tokens = fmt_tokens(total_tokens)

        # Format cost
        if cost != "?":
            try:
                cost = f"${float(cost):.2f}"
            except ValueError:
                pass

        print(f"  {bold(sid)}  {task}  {dim(f'{runner}:{model_name}')}")
        detail_parts = []
        if elapsed_str:
            detail_parts.append(f"elapsed: {elapsed_str}")
        detail_parts.append(f"turns: {turns}")
        detail_parts.append(f"tokens: {total_tokens}")
        detail_parts.append(f"output: {output_tokens}")
        detail_parts.append(f"cost: {cost}")
        print(f"    {dim(' · '.join(detail_parts))}")

print()

# Exit code: 0 if any slot dispatchable
sys.exit(0 if dispatch_ok > 0 else 1)
