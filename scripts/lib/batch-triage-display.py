#!/usr/bin/env python3
"""Display batch triage results from score files.

Usage: batch-triage-display.py <scores-dir> <issues-json> <repo> [display-labels]

Reads score files from <scores-dir>, matches against issues in <issues-json>,
and renders a colored table sorted by one-shot probability.
"""

import json
import os
import shutil
import sys

if len(sys.argv) < 4:
    print("Usage: batch-triage-display.py <scores-dir> <issues-json> <repo> [display-labels]", file=sys.stderr)
    sys.exit(1)

scores_dir = sys.argv[1]
issues_file = sys.argv[2]
repo = sys.argv[3]
display_labels = sys.argv[4] if len(sys.argv) > 4 else ""

issues = json.load(open(issues_file))

# ── Colors ───────────────────────────────────────────────────────────
use_color = sys.stdout.isatty()


def c(code, text):
    if not use_color:
        return text
    return f"\033[{code}m{text}\033[0m"


def green(t): return c("0;32", t)
def red(t): return c("0;31", t)
def yellow(t): return c("0;33", t)
def cyan(t): return c("0;36", t)
def dim(t): return c("2", t)
def bold(t): return c("1", t)


def color_difficulty(d):
    if d == "low":
        return green(d)
    if d == "medium":
        return yellow(d)
    if d == "high":
        return red(d)
    if d == "extreme":
        return c("1;31", d)  # bold red
    return d


def color_prob(p):
    s = f"{p:.2f}"
    if p >= 0.7:
        return green(s)
    if p >= 0.4:
        return yellow(s)
    return red(s)


def color_valid(valid, conf):
    if valid is None:
        return dim("--")
    if valid:
        return green("yes") + " " + dim(f"{conf:.0%}")
    return red("NO") + "  " + dim(f"{conf:.0%}")


def pad(text, width, raw_text):
    """Pad colored text to a fixed visual width based on raw_text length."""
    pad_len = width - len(raw_text)
    if pad_len > 0:
        return text + " " * pad_len
    return text


# ── Collect issue refs ───────────────────────────────────────────────
refs = set()
for issue in issues:
    if "number" in issue:
        refs.add(f"gh-{issue['number']}")
    elif "key" in issue:
        refs.add(issue["key"].lower())

# ── Load scores ──────────────────────────────────────────────────────
rows = []
for ref in sorted(refs):
    path = os.path.join(scores_dir, f"{ref}.json")
    if not os.path.exists(path):
        continue
    try:
        score = json.load(open(path))
        h = score.get("heuristic", {})
        v = score.get("validation", {})
        issue_ref = score.get("issue_ref", ref)
        if "#" in issue_ref:
            display_num = issue_ref.rsplit("#", 1)[-1]
        else:
            display_num = issue_ref
        rows.append({
            "num": display_num,
            "difficulty": h.get("difficulty", "?"),
            "prob": h.get("one_shot_probability", 0),
            "category": h.get("category", "?"),
            "title": score.get("bug_input", {}).get("title", ""),
            "valid": v.get("still_valid", None),
            "valid_conf": v.get("confidence", 0),
            "valid_reason": v.get("reason", ""),
        })
    except (json.JSONDecodeError, KeyError):
        continue

rows.sort(key=lambda r: r["prob"], reverse=True)

# ── Terminal width ───────────────────────────────────────────────────
term_width = shutil.get_terminal_size((120, 24)).columns

# ── Header ───────────────────────────────────────────────────────────
header = f"Batch triage: {bold(repo)}"
if display_labels:
    header += f" ({cyan(display_labels)})"
print(header)
print(f"Scored: {bold(str(len(rows)))} issues")
print()

if not rows:
    print(dim("No scored results."))
    sys.exit(0)

# ── Table ────────────────────────────────────────────────────────────
has_validation = any(r["valid"] is not None for r in rows)

# Column widths (raw, before color codes)
col_num = 7
col_diff = 8
col_prob = 7
col_valid = 9
col_cat = 16

# Title gets remaining space
if has_validation:
    fixed = col_num + col_diff + col_prob + col_valid + col_cat + 14  # separators
else:
    fixed = col_num + col_diff + col_prob + col_cat + 11
col_title = max(20, term_width - fixed)

# Header line
sep = dim(" | ")
if has_validation:
    hdr = (
        bold(f"{'#':<{col_num}}")
        + sep + bold(f"{'Difficulty':<{col_diff}}")
        + sep + bold(f"{'P(1-sh)':<{col_prob}}")
        + sep + bold(f"{'Valid?':<{col_valid}}")
        + sep + bold(f"{'Category':<{col_cat}}")
        + sep + bold("Title")
    )
else:
    hdr = (
        bold(f"{'#':<{col_num}}")
        + sep + bold(f"{'Difficulty':<{col_diff}}")
        + sep + bold(f"{'P(1-sh)':<{col_prob}}")
        + sep + bold(f"{'Category':<{col_cat}}")
        + sep + bold("Title")
    )
print(hdr)
print(dim("-" * min(term_width, 120)))

# Rows
for r in rows:
    title = r["title"][:col_title]

    # Dim the row if validated as fixed
    if r["valid"] is False:
        num = pad(dim(r["num"]), col_num, r["num"])
        diff = pad(dim(r["difficulty"]), col_diff, r["difficulty"])
        prob = pad(dim(f"{r['prob']:.2f}"), col_prob, f"{r['prob']:.2f}")
        cat = pad(dim(r["category"]), col_cat, r["category"])
        title = dim(title)
    else:
        num = f"{r['num']:<{col_num}}"
        diff = pad(color_difficulty(r["difficulty"]), col_diff, r["difficulty"])
        prob = pad(color_prob(r["prob"]), col_prob, f"{r['prob']:.2f}")
        cat = f"{r['category']:<{col_cat}}"

    if has_validation:
        conf_str = f"{r['valid_conf']:.0%}"
        valid_raw = "--" if r["valid"] is None else (f"yes {conf_str}" if r["valid"] else f"NO  {conf_str}")
        valid = pad(color_valid(r["valid"], r["valid_conf"]), col_valid, valid_raw)
        print(f"{num}{sep}{diff}{sep}{prob}{sep}{valid}{sep}{cat}{sep}{title}")
    else:
        print(f"{num}{sep}{diff}{sep}{prob}{sep}{cat}{sep}{title}")

# ── Summary ──────────────────────────────────────────────────────────
print()
valid_rows = [r for r in rows if r["valid"] is not False]
low_wins = sum(1 for r in valid_rows if r["difficulty"] == "low" and r["prob"] >= 0.7)
expired = sum(1 for r in rows if r["valid"] is False)

if low_wins > 0:
    print(green(f"Low-effort wins (low + p>=0.7): {low_wins}"))
else:
    print(dim(f"Low-effort wins (low + p>=0.7): 0"))

if expired:
    print(red(f"Likely fixed/expired: {expired}"))

# Show validation reasons if present
if has_validation:
    invalid = [r for r in rows if r["valid"] is False and r.get("valid_reason")]
    if invalid:
        print()
        print(bold("Likely fixed:"))
        for r in invalid:
            print(f"  {dim('#' + r['num'])} {r['valid_reason']}")
