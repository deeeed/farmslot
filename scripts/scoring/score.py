#!/usr/bin/env python3
"""Default bug difficulty scorer — generic heuristics, no project tuning needed.

Projects can override by setting scoring.script in project.json to point to
their own scorer. This default is the fallback when no project scorer exists.

Accepts multiple input formats:
  - bug-input.json (farmslot internal — has "source" field)
  - Raw GitHub API issue JSON (has "number" + "html_url")
  - Raw Jira API JSON (has "key" + "fields") — future

Usage:
    python3 scripts/scoring/score.py --input path/to/bug.json
    cat bug.json | python3 scripts/scoring/score.py --stdin
"""

import argparse
import json
import re
import sys


# ── Format detection & normalization ─────────────────────────────

def detect_format(data: dict) -> str:
    """Auto-detect input format: 'bug-input', 'github', or 'jira'."""
    if "source" in data:
        return "bug-input"
    if "number" in data and "html_url" in data:
        return "github"
    if "key" in data and "fields" in data:
        return "jira"
    if "title" in data and "description" in data:
        return "bug-input"
    raise ValueError(
        "Cannot detect input format. Expected bug-input.json (has 'source'), "
        "GitHub API JSON (has 'number' + 'html_url'), or Jira JSON (has 'key' + 'fields')."
    )


def extract_issue_ref(data: dict, fmt: str) -> str:
    """Extract a caller-correlation issue reference."""
    if fmt == "bug-input":
        gh = data.get("github_issue", "")
        if gh:
            return gh
        src = data.get("source", {})
        if isinstance(src, dict) and src.get("type") == "github":
            return f"{src.get('repo', '')}#{src.get('issue_number', '')}"
        return ""
    if fmt == "github":
        html_url = data.get("html_url", "")
        m = re.match(r"https://github\.com/([^/]+/[^/]+)/issues/(\d+)", html_url)
        if m:
            return f"{m.group(1)}#{m.group(2)}"
        number = data.get("number")
        if number:
            return f"#{number}"
        return ""
    if fmt == "jira":
        return data.get("key", "")
    return ""


def _parse_body_section(body: str, heading: str) -> list[str]:
    """Extract lines under a markdown heading from issue body."""
    pattern = rf"(?:^|\n)#+\s*{heading}\s*\n(.*?)(?=\n#+\s|\Z)"
    m = re.search(pattern, body, re.IGNORECASE | re.DOTALL)
    if not m:
        return []
    section = m.group(1).strip()
    lines = [l.strip().lstrip("- ").lstrip("* ").strip() for l in section.split("\n") if l.strip()]
    return [l for l in lines if l]


def normalize_github(data: dict) -> dict:
    """Normalize raw GitHub API issue JSON to bug-input format."""
    body = data.get("body", "") or ""
    labels = [l["name"] if isinstance(l, dict) else l for l in data.get("labels", [])]

    steps = (_parse_body_section(body, "Steps to [Rr]eproduce")
             or _parse_body_section(body, "Repro(?:duction)? [Ss]teps"))

    screenshots = re.findall(r'!\[.*?\]\(.*?\)|<img\s[^>]*src=["\']([^"\']+)', body)
    linked_prs = re.findall(r'(?:^|\s)#(\d+)', body)

    components = []
    for label in labels:
        if label.startswith("team-"):
            components.append(label[5:])

    ac = (_parse_body_section(body, "Acceptance [Cc]riteria")
          or _parse_body_section(body, "Expected [Bb]ehavior"))

    return {
        "title": data.get("title", ""),
        "description": body,
        "labels": labels,
        "steps_to_reproduce": steps,
        "acceptance_criteria": ac,
        "screenshots": screenshots,
        "components": components,
        "linked_prs": linked_prs,
    }


def normalize_input(data: dict) -> tuple[dict, str, str]:
    """Normalize any supported format. Returns (bug_dict, format, issue_ref)."""
    fmt = detect_format(data)
    issue_ref = extract_issue_ref(data, fmt)

    if fmt == "github":
        bug = normalize_github(data)
    elif fmt == "jira":
        raise NotImplementedError("Jira format not yet supported")
    else:
        bug = data

    return bug, fmt, issue_ref


# ── Generic scoring ──────────────────────────────────────────────

DIFFICULTY_THRESHOLDS = {
    "low":     {"max_score": 35, "one_shot_range": [0.70, 0.90]},
    "medium":  {"max_score": 55, "one_shot_range": [0.40, 0.70]},
    "high":    {"max_score": 75, "one_shot_range": [0.15, 0.40]},
    "extreme": {"max_score": 100, "one_shot_range": [0.00, 0.15]},
}

MODEL_RECOMMENDATIONS = {
    "low":     {"model": "sonnet", "estimated_tokens": 30000, "estimated_cost_usd": 0.05},
    "medium":  {"model": "sonnet", "estimated_tokens": 60000, "estimated_cost_usd": 0.12},
    "high":    {"model": "opus",   "estimated_tokens": 120000, "estimated_cost_usd": 0.80},
    "extreme": {"model": "opus",   "estimated_tokens": 200000, "estimated_cost_usd": 1.50},
}


def calculate_difficulty_score(bug: dict) -> tuple[int, list[str]]:
    """Calculate a 0-100 difficulty score using generic heuristics.

    Aligned with automation repo's validate-pipeline.py signals,
    inverted from feasibility (higher=easier) to difficulty (higher=harder).
    """
    score = 40
    details = []

    title = bug.get("title", "").lower()
    desc = bug.get("description", "").lower()
    labels = [l.lower() for l in bug.get("labels", [])]
    steps = bug.get("steps_to_reproduce", [])
    ac = bug.get("acceptance_criteria", [])
    screenshots = bug.get("screenshots", [])
    components = bug.get("components", [])
    combined = f"{title} {desc}"

    # ── Easy bug signals (reduce difficulty) ─────────────────────────

    if any(kw in combined for kw in ["translation", "i18n", "locale", "localization", "untranslated"]):
        score -= 25
        details.append("-25: translation/i18n bug")

    if any(kw in title for kw in ["typo", "text", "copy", "wording", "string"]):
        score -= 20
        details.append("-20: text/typo in title")

    if any(kw in combined for kw in ["style", "theme", "color", "alignment", "dark mode", "light mode"]):
        score -= 20
        details.append("-20: style/theme/color/alignment bug")

    if any(kw in combined for kw in ["input", "keyboard", "cursor", "textinput", "text input"]):
        score -= 15
        details.append("-15: input/keyboard/textinput bug")

    if any(kw in combined for kw in ["carousel", "banner", "modal", "button", "icon", "badge", "toast", "snackbar"]):
        score -= 15
        details.append("-15: UI component bug")

    if any(kw in labels for kw in ["ui", "ui/ux", "design", "ux"]):
        score -= 15
        details.append("-15: UI/layout label")

    easy_patterns = ["missing", "empty", "blank", "undefined", "null", "not showing",
                     "not displayed", "wrong", "incorrect", "not visible",
                     "overlap", "scroll", "truncat"]
    if any(kw in combined for kw in easy_patterns):
        score -= 15
        details.append("-15: easy pattern (missing/wrong/display)")

    if any(kw in combined for kw in ["navigation", "deeplink", "universal link", "navigate"]):
        score -= 10
        details.append("-10: navigation/deeplink bug")

    if any(kw in combined for kw in ["balance", "amount", "price", "value", "decimal", "format"]):
        score -= 10
        details.append("-10: display value bug (balance/amount/price)")

    if any(kw in labels for kw in ["regression"]):
        score -= 10
        details.append("-10: regression label")

    if any(kw in labels for kw in ["sev3", "low", "minor", "sev4"]):
        score -= 5
        details.append("-5: low severity label")

    if screenshots:
        score -= 5
        details.append("-5: has visual evidence (screenshots/video)")

    if any(l.startswith("team-") for l in labels):
        score -= 5
        details.append("-5: team assigned")

    # ── Hard bug signals (increase difficulty) ───────────────────────

    external_kw = ["sentry", "bitrise", "firebase", "analytics", "crashlytics",
                   "ci-cd", "ci/cd", "build fail", "deployment", "release", "app store",
                   "play store", "codepush"]
    if any(kw in combined for kw in external_kw):
        score += 25
        details.append("+25: external system (sentry/firebase/CI/store)")

    if any(kw in labels for kw in ["crash", "sev1", "critical"]) or "crash" in title:
        score += 15
        details.append("+15: crash/sev1/critical")

    if any(kw in labels for kw in ["performance", "security", "vulnerability"]):
        score += 10
        details.append("+10: complex domain (performance/security)")

    if any(kw in combined for kw in ["memory", "leak", "optimization", "slow", "lag", "jank"]):
        score += 10
        details.append("+10: performance issue")

    if any(kw in title for kw in ["network", "api", "backend", "server", "rpc"]):
        score += 10
        details.append("+10: backend/network in title")

    if len(desc) > 1500:
        score += 5
        details.append("+5: long description (>1500 chars, likely complex)")

    # ── Clarity signals ──────────────────────────────────────────────

    if steps and len(steps) >= 2:
        score -= 10
        details.append("-10: clear reproduction steps")
    elif not steps:
        score += 10
        details.append("+10: no reproduction steps")

    if ac and len(ac) >= 1:
        score -= 5
        details.append("-5: has acceptance criteria")

    if re.search(r"error|exception|traceback|stack trace|typeerror|referenceerror", desc):
        score -= 10
        details.append("-10: contains error information")

    if "```" in desc or "code" in bug.get("description", ""):
        score -= 5
        details.append("-5: contains code context")

    # ── Complexity signals ───────────────────────────────────────────

    if any(w in title for w in ["intermittent", "flaky", "random", "sometimes"]):
        score += 20
        details.append("+20: intermittent/flaky (hard to reproduce)")

    platforms_mentioned = sum(1 for p in ["ios", "android"] if p in desc)
    if platforms_mentioned > 1:
        score += 10
        details.append("+10: affects multiple platforms")

    if len(components) > 1:
        score += 10
        details.append(f"+10: crosses {len(components)} components")

    if any(l in labels for l in ["good first issue", "easy", "good-first-issue"]):
        score -= 10
        details.append("-10: labeled easy/good-first-issue")
    if any(l in labels for l in ["blocked", "waiting", "needs-discussion"]):
        score += 15
        details.append("+15: blocked/waiting label")

    linked_prs = bug.get("linked_prs", [])
    if len(linked_prs) > 1:
        score += 15
        details.append(f"+15: {len(linked_prs)} linked PRs (prior attempts?)")
    elif len(linked_prs) == 1:
        score += 5
        details.append("+5: has linked PR (may need to build on it)")

    score = max(0, min(100, score))
    return score, details


def score_to_difficulty(score: int) -> str:
    for level in ["low", "medium", "high", "extreme"]:
        if score <= DIFFICULTY_THRESHOLDS[level]["max_score"]:
            return level
    return "extreme"


def estimate_one_shot_probability(score: int, difficulty: str) -> float:
    lo, hi = DIFFICULTY_THRESHOLDS[difficulty]["one_shot_range"]
    max_score = DIFFICULTY_THRESHOLDS[difficulty]["max_score"]
    levels = ["low", "medium", "high", "extreme"]
    idx = levels.index(difficulty)
    min_score = DIFFICULTY_THRESHOLDS[levels[idx - 1]]["max_score"] if idx > 0 else 0
    if max_score == min_score:
        return (lo + hi) / 2
    t = (score - min_score) / (max_score - min_score)
    return round(hi - t * (hi - lo), 2)


def main():
    parser = argparse.ArgumentParser(description="Score bug difficulty (default scorer)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", help="Path to bug JSON file")
    group.add_argument("--stdin", action="store_true", help="Read JSON from stdin")
    args = parser.parse_args()

    if args.stdin:
        raw = json.load(sys.stdin)
    else:
        with open(args.input) as f:
            raw = json.load(f)

    bug, _fmt, issue_ref = normalize_input(raw)

    score, details = calculate_difficulty_score(bug)
    difficulty = score_to_difficulty(score)
    probability = estimate_one_shot_probability(score, difficulty)

    model_rec = MODEL_RECOMMENDATIONS.get(difficulty, {})

    result = {
        "issue_ref": issue_ref,
        "difficulty": difficulty,
        "difficulty_score": score,
        "one_shot_probability": probability,
        "recommended_model": model_rec.get("model", "sonnet"),
        "estimated_tokens": model_rec.get("estimated_tokens", 60000),
        "estimated_cost_usd": model_rec.get("estimated_cost_usd", 0.12),
        "category": "general",
        "category_confidence": "low",
        "scoring_details": details,
    }

    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
