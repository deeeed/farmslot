# Worker: Interactive Dev — {{TICKET_ID}}

> **Signal file:** Write `{{TASK_DIR}}/SIGNAL.json` only when the operator asks you to complete.
> **Checklist marker:** After each checklist item, run `{{TASK_DIR}}/mark N` (1-based). The final item can add `--status complete --outcome success`.

---

## Task

```text
TICKET: {{TICKET_ID}}
TITLE: {{TICKET_TITLE}}
BRANCH: {{BRANCH}}
TASK_DIR: {{TASK_DIR}}
STATUS: pending
```

## Interactive protocol

- The human operator drives scope, order, review, and whether/when to publish.
- Keep changes local unless the operator explicitly tells you otherwise.
- Avoid publishing, pushing, or mutating GitHub PRs unless explicitly instructed.
- Keep `{{TASK_DIR}}/CHECKLIST.md` and `{{TASK_DIR}}/inputs/dev-intake.json` current when they exist.

## Completion signal

When the operator says the interactive session is complete:

1. Write `{{TASK_DIR}}/artifacts/report.md` with files changed, summary, validation run, and any remaining risks.
2. If screenshots/videos prove the change, write `{{TASK_DIR}}/artifacts/evidence-manifest.json` with strict top-level keys: `version`, `preferred_mode`, `summary`, `before_after_pairs`, `standalone`, `omit`, `videos`. Use `before_after_pairs` for comparisons; omit the manifest when there is no visual evidence.
3. Set the task status line to `STATUS: done`.
4. Write the completion signal:

```bash
{{TASK_DIR}}/mark 4 --status complete --outcome success
```

**Do NOT `/exit`.** Stay alive and idle in this session — the operator may attach at the publication gate to ask why/how questions before publish.
