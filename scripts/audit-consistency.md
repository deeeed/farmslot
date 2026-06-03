# Consistency Audit Prompt

Run this on principal (in plan mode) to detect inconsistencies across 06-agent-farm/:

---

Audit all files in 06-agent-farm/ for inconsistencies. Use DISPATCH-PROTOCOL.md and templates/worker/fix-bug.md as the source of truth. Check every other file against them.

For each inconsistency found, report:

- File path
- Line number(s)
- What it currently says
- What it should say (per source of truth)

Group findings by category. Do not fix anything — report only.

Key things to check:

1. Role names: should be "Orchestrator" (not Principal, Coach, or split roles)
2. REPO vs WORKTREE: all vars should be REPO
3. Status tracking: TASK file (not .task.md)
4. Report file: report.md (not summary.md)
5. Metro log path: `{{RUNTIME_DIR}}/metro.log` in templates/fixtures (resolves to `.agent/metro.log` for example-mobile via project.json `paths.runtime_dir`)
6. Agent launch: AGENT_CMD (not hardcoded claude)
7. Logger: DevLogger.log (not Logger.log)
8. PR creation: done by Orchestrator in preflight (not by worker)
9. Deleted file references: DISPATCH-PATTERNS.md, FAST-PATH-PREFLIGHT.md, AGENTIC-PIPELINE.md no longer exist
10. Per-machine CLAUDE.local files: should not exist (constraints go in TASK files)
11. Artifacts path: `{{ARTIFACT_DIR}}/<pr>/` in templates/fixtures (configured via `paths.artifact_dir` in project.json, default `automation`). Runtime files (metro.log, wallet-fixture.json) use `{{RUNTIME_DIR}}/` (configured via `paths.runtime_dir`, default `.agent`).
12. yarn jest: should be yarn coverage:analyze

---

After reporting, ask Arthur if he wants to fix all issues.
