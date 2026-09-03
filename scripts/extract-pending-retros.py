#!/usr/bin/env python3
"""Extract pending retros from .runs/*.json into per-project digest markdown.

Read-only over .runs/. Writes digests under .omc/retro-digest/.
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from glob import glob
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RUNS_DIR = REPO / ".runs"
OUT_DIR = REPO / ".omc" / "retro-digest"


def load_pending():
    """Yield every unresolved retro — runs may carry several after supersession."""
    pending = []
    for f in sorted(glob(str(RUNS_DIR / "*.json"))):
        try:
            run = json.load(open(f))
        except Exception:
            continue
        for dec in run.get("decisions") or []:
            if dec.get("type") != "retrospective":
                continue
            if dec.get("resolvedAt"):
                continue
            pending.append((run, dec))
    return pending


def fmt_metrics(m):
    if not isinstance(m, dict):
        return ""
    parts = []
    if m.get("model"):
        parts.append(f"model={m['model']}")
    if m.get("runner"):
        parts.append(f"runner={m['runner']}")
    if m.get("nudgeCount") is not None:
        parts.append(f"nudges={m['nudgeCount']}")
    dur = m.get("durationMs")
    if dur:
        parts.append(f"dur={int(dur/60000)}m")
    turns = m.get("sessionTurns")
    if turns:
        parts.append(f"turns={turns}")
    return " ".join(parts)


def fmt_links(links):
    if not isinstance(links, list):
        return ""
    return " · ".join(f"[{l.get('label','?')}]({l.get('url','')})" for l in links if l.get("url"))


def fmt_ciwatch(cw):
    if not isinstance(cw, dict):
        return ""
    return f"ci={cw.get('result','?')} ({cw.get('passed',0)}p/{cw.get('failed',0)}f/{cw.get('pending',0)}w of {cw.get('total',0)})"


def real_review_items(excerpt):
    """Pull rows triaged REAL out of the markdown table excerpt."""
    if not isinstance(excerpt, str):
        return []
    rows = []
    headers = None
    for line in excerpt.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        normalized = [c.lower().rstrip("?") for c in cells]
        if "triage" in normalized:
            headers = normalized
            continue
        if headers is None or all(set(c) <= {"-", ":"} for c in cells):
            continue
        triage_idx = headers.index("triage")
        if triage_idx >= len(cells):
            continue
        triage = cells[triage_idx].upper()
        if "REAL" in triage and "OUT" not in triage:
            author_idx = headers.index("author") if "author" in headers else None
            file_idx = next((headers.index(name) for name in ("file", "where") if name in headers), None)
            action_idx = headers.index("action") if "action" in headers else None
            rows.append(
                {
                    "author": cells[author_idx] if author_idx is not None and author_idx < len(cells) else "?",
                    "file": cells[file_idx] if file_idx is not None and file_idx < len(cells) else "(report)",
                    "triage": cells[triage_idx],
                    "action": cells[action_idx] if action_idx is not None and action_idx < len(cells) else "See report excerpt",
                }
            )
    return rows


def step_failures(steps):
    out = []
    for s in steps or []:
        if s.get("status") == "failed" or s.get("error"):
            out.append(f"{s.get('name','?')}: {(s.get('error') or s.get('status') or '')[:200]}")
    return out


def write_digest(project, items, today):
    outfile = OUT_DIR / f"{today}-{project.replace('-farm','')}.md"
    lines = []
    lines.append(f"# Pending retro digest — {project} ({today})")
    lines.append("")
    lines.append(f"{len(items)} pending retros. Source: `.runs/<id>.json` decisions where `type=retrospective` and `resolvedAt=null`.")
    lines.append("")
    lines.append("Run IDs (use for bulk-resolve in Pass 3):")
    lines.append("```")
    for run, _ in items:
        lines.append(run["id"])
    lines.append("```")
    lines.append("")

    # Group by flowType
    by_flow = defaultdict(list)
    for run, dec in items:
        by_flow[run.get("flowType", "?")].append((run, dec))

    for flow, group in sorted(by_flow.items()):
        lines.append(f"## flow: `{flow}` — {len(group)} runs")
        lines.append("")
        for run, dec in sorted(group, key=lambda x: x[1].get("createdAt") or ""):
            payload = dec.get("payload") or {}
            outcome = payload.get("outcome", "?")
            summary = run.get("summary") or run.get("ticketData", {}).get("title", "") or "(no summary)"
            ticket = run.get("ticketOrPr", "")
            branch = run.get("branch", "")
            metrics = fmt_metrics(run.get("metrics"))
            links = fmt_links(run.get("links"))
            ciwatch = fmt_ciwatch(payload.get("ciWatch"))
            real_items = real_review_items(payload.get("reportExcerpt"))
            triage_summary = payload.get("commentsTriageSummary") or {}
            structured_real = triage_summary.get("real", 0)
            if not isinstance(structured_real, int):
                structured_real = 0
            real_count = max(len(real_items), structured_real)
            failures = step_failures(run.get("steps"))
            created = (dec.get("createdAt") or "")[:10]

            lines.append(f"### {ticket} — {summary}")
            lines.append("")
            lines.append(f"- run: `{run['id']}` · created: {created} · outcome: **{outcome}**")
            lines.append(f"- branch: `{branch}`")
            if metrics:
                lines.append(f"- metrics: {metrics}")
            if links:
                lines.append(f"- links: {links}")
            if ciwatch:
                lines.append(f"- {ciwatch}")
            if failures:
                lines.append(f"- step failures:")
                for fail in failures:
                    lines.append(f"  - {fail}")
            if real_count:
                lines.append(f"- review items flagged REAL ({real_count}):")
                for it in real_items:
                    file_short = it["file"].split("/")[-1] if it["file"] else "(conv)"
                    lines.append(f"  - **{file_short}** — {it['action']} _(by {it['author']})_")
                missing_details = real_count - len(real_items)
                if missing_details:
                    lines.append(
                        f"  - {missing_details} additional REAL item(s) recorded in structured triage; "
                        "the report excerpt has no parseable table row"
                    )
            else:
                lines.append("- review items: none REAL (all out-of-scope/clean)")
            lines.append("")

        lines.append("")

    # Theme placeholder for curation pass
    lines.append("---")
    lines.append("")
    lines.append("## Curation notes (fill during Pass 2)")
    lines.append("")
    lines.append("Group recurring patterns into LEARNINGS.md candidates. Examples to look for:")
    lines.append("")
    lines.append("- Recipe gaps (missing actions, validator mismatches)")
    lines.append("- Slot prep regressions (branch guard, CDP drop, fixture sync)")
    lines.append("- Worker discipline issues (skipped checklist, premature batching)")
    lines.append("- Review noise (low-signal bot comments overweighted)")
    lines.append("- CI-watch misclassifications")
    lines.append("- Cost/duration outliers vs flow median")
    lines.append("")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outfile.write_text("\n".join(lines))
    return outfile


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pending = load_pending()
    by_project = defaultdict(list)
    for run, dec in pending:
        proj = run.get("project") or "unknown"
        by_project[proj].append((run, dec))

    print(f"pending retros: {len(pending)}")
    written = []
    for proj, items in sorted(by_project.items()):
        out = write_digest(proj, items, today)
        written.append(out)
        print(f"  {proj}: {len(items)} → {out.relative_to(REPO)}")

    if not written:
        print("nothing to write")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
