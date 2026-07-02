# Worker template format conventions

Stable reference for how the gateway parses rendered worker TASK.md files into structured progress. See [ADR-011](../adr/011-structured-task-tracking.md) for the decision record.

## Purpose

Worker templates are plain markdown. The gateway derives phases and steps at read time via `generateTaskSchema()` in `services/gateway/src/tasks/writer.ts` — no sidecar schema file.

## Structure rules

| Element                           | Role                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `##` / `###` / `####` headings    | Start a **phase**. The heading text becomes the phase name in Command Center. |
| `- [ ]` / `- [x]` checkboxes      | **Steps** within the current phase.                                           |
| Checkboxes before any heading     | Collected into a default **Checklist** phase.                                 |
| Fenced code blocks                | Ignored by the parser (including interpolated PR bodies).                     |
| `<details>` blocks                | Skipped (reference sections).                                                 |
| Headings with no checkboxes below | Pruned (empty phases removed).                                                |

## Skipped informational sections

Headings whose names match these patterns are treated as informational — checkboxes inside them do **not** become worker steps:

- acceptance criteria
- description
- task (metadata block)
- affected area
- screenshots
- comments
- root cause
- rules
- recipe acs
- pre-merge

This prevents PR-body checklists or ticket AC blocks from inflating the progress schema.

## Step naming

Checkbox text becomes the step label. Bold numbering is normalized:

```markdown
- [ ] **3. Run tests** — becomes step name `3. Run tests`
```

## Title extraction

The parser uses the first `#` or `##` heading as the schema title when present; otherwise it falls back to the flow type (`fix-bug`, `review-pr`, …).

## Signal file boundary

`SIGNAL.json` (or flow-specific signal files such as `CI-FIX-SIGNAL.json`) carries **terminal** status only. Ongoing progress lives in checkbox state inside TASK.md. See [worker signal protocol](../../apps/docs/docs/reference/worker-signal-protocol.md) on the docs site.

## Template variables

Placeholder expansion (`{{VAR}}`) happens **before** parsing. See [template-variables.md](./template-variables.md) for the variable catalog.

## Authoring checklist

1. Keep observable checkboxes in dedicated `##` phases (Validate, Finish, …).
2. Put ticket/PR metadata in a fenced ` ```text ` block or a skipped section — not as fake steps.
3. Tell workers to use `{{TASK_DIR}}/mark N` for step updates when the template includes the mark helper.
4. Run `yarn quality:worker-templates projects/<your-farm>` before merging template changes.
