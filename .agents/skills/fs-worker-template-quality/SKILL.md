---
name: fs-worker-template-quality
description: Optional authoring review for Farmslot worker prompt templates — run deterministic contract/structure lint, then critique succinctness, contradictions, checklist flow, and stop conditions. Not part of slot lifecycle; for pack maintainers editing templates/worker/*.md.
---

# FS Worker Template Quality

Optional **developer tool** for people authoring or editing worker templates in a Farmslot project pack (`projects/<name>/templates/worker/*.md`).

This skill is **not plugged into** gateway, dispatch, monitor, slot prepare, or CI LLM gates. Runtime finish behavior still comes from `./mark`, task artifacts, and (in Farmslot) the run monitor.

## When to use

- Adding or editing a flow template (`fix-bug.md`, `dev.md`, `review-pr.md`, …)
- Onboarding a new farm project with custom worker prompts
- After a large template sweep (e.g. learnings + `./mark` alignment across MM farms)
- Before opening a PR that only touches `templates/worker/`

## Step 1 — Deterministic lint (required)

From a Farmslot checkout, run the contract + structure script against the project and/or a single file:

```bash
# Whole project
yarn quality:worker-templates projects/my-farm

# Or directly
node scripts/quality/check-worker-template-contract.mjs projects/my-farm

# Single template (walks up to project.json for worker_terminal overrides)
node scripts/quality/check-worker-template-contract.mjs projects/my-farm/templates/worker/fix-bug.md
```

This checks:

- Terminal `./mark` / `mark-checklist-step … complete` instructions
- Required artifact paths for the inferred flow (`learnings.md`, flow reports, …)
- `project.json` `worker_terminal.flows` overrides when present
- Structure: `{{TASK_DIR}}` brace typos, duplicate checklist step numbers, missing `## Task` / checklist sections

**If the script fails, fix those issues before heuristic review.** Do not hand-wave contract failures.

Reference: [Worker template quality](https://farmslot.io/docs/reference/worker-template-quality) (docs site) and [Finish a worker run](https://farmslot.io/docs/reference/worker-run-finish) for artifact tables.

## Step 2 — Heuristic review (this skill)

Read the template(s) and optional neighbors (same flow in another farm for comparison). Apply the rubric below.

### Rubric

| Area                | Good                                                                                                                  | Flag                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Succinctness**    | Each step is one observable action; no paragraph-length bullets                                                       | Redundant restatement of the same gate; duplicate validation blocks                      |
| **Contradictions**  | Push vs no-push, `/exit` vs stay alive, autonomous vs human gate are consistent                                       | “Never push” next to “push origin”; “Do NOT /exit” missing on publication-gate flows     |
| **Checklist flow**  | Phases ordered: context → work → validate → artifacts → signal                                                        | Signal before artifacts; validate after commit without saying so                         |
| **Stop conditions** | Clear when to `blocked`, `no-change`, or stop without signal                                                          | Ambiguous “if blocked, stop” without `./mark blocked` or STATUS guidance                 |
| **Format**          | Signal header block, `## Task` metadata, numbered checklist                                                           | Missing TASK_DIR; free-form prose without checkboxes on terminal flows                   |
| **Finish contract** | Learnings step + flow report + `./mark complete --mark-last` (or documented operator-only completion for interactive) | Hand-write `SIGNAL.json` without `./mark`; learnings mentioned only as inherited context |
| **Recipe sections** | Recipe steps reference manifest actions; CDP/recording gates explicit                                                 | UI value injection; skip validation without “unless …” scope                             |
| **Cross-template**  | Same farm uses consistent tone for mark header, learnings guidance, publication rules                                 | One template allows `gh pr create` while siblings say gateway owns publish               |

### Severity

Order findings as:

1. **Blocking** — would cause wrong runtime behavior, contract failure, or agent confusion at the signal step
2. **Should-fix** — unclear, verbose, or inconsistent; likely to waste tokens or cause mistakes
3. **Nit** — wording, ordering polish, optional cross-links

Do **not** fail templates for learnings bullet count — only require that a learnings write step exists (deterministic lint already enforces reference paths).

## Required output sections

Always return:

1. **Deterministic lint** — paste command run + PASS/FAIL; list script errors verbatim on FAIL
2. **Verdict** — `PASS`, `PASS_WITH_NITS`, or `ISSUES`
3. **Blocking**
4. **Should-fix**
5. **Nits**
6. **Suggested edits** — concrete checklist line or section deltas (prose or diff-style), top 3 first

## Actionability rule

Every heuristic finding should suggest a specific edit (add step N, move learnings before signal, split phase header, delete duplicate paragraph, align with `dev.md` pattern).

Do not auto-edit template files unless the user asks.

## Good inputs

- `projects/<farm>/` path
- One or more `templates/worker/*.md` paths
- Optional: “compare to farmslot-farm `fix-bug.md`”
- Optional: flow type if filename is ambiguous (`ci-fix`, `self-review`, …)

## Out of scope

- Enforcing template quality during dispatch or monitor
- Replacing `./mark` or gateway artifact contract at runtime
- Grading live worker _runs_ (use family observability / retrospective for that)
- Recipe graph quality (use `fs-recipe-quality` instead)

## Related

- Deterministic script: `scripts/quality/check-worker-template-contract.mjs`
- Contract resolver: `scripts/quality/worker-terminal-contract.cjs`
- Worker finish checklist: `apps/docs/docs/reference/worker-run-finish.md`
- Customize prompts guide: `apps/docs/docs/guides/customize-worker-prompts.md`
