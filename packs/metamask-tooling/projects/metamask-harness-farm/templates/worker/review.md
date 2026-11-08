# Worker: Review (MetaMask harness)

> Operator-requested publication review. Execute the checklist directly; do not use shortcut review commands.
> Mark with `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} N` after each item.

Static review reads source, the diff, recorded evidence, existing CI results and deterministic receipts only. Do not run tests, builds, recipes, installs, probes or ad hoc validation scripts. A claim without evidence is a finding or marked unverified.

```
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
VALIDATION_DEPTH: {{VALIDATION_DEPTH}}
```

## Checklist

- [ ] **1. Start** - run `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} start`, then the same command with `1`.
- [ ] **2. Read the rules** - `{{REPO}}/CLAUDE.md` (its hard rules are blocking) and `{{TASK_DIR}}/artifacts/report.md`, `pr-description.md`, `recipe-coverage.md`.
- [ ] **3. Read the diff** - `git -C {{REPO}} diff origin/{{DEFAULT_BRANCH}}...HEAD`, every changed file in full. Check root cause, minimality, no duplicated logic, no edits under `node_modules`, and a `CHANGELOG.md` Unreleased entry for user-visible changes.
- [ ] **4. Inspect recorded validation** - read `{{TASK_DIR}}/artifacts/deterministic-checks/` receipts and logs and existing CI results. Missing evidence is a finding.
- [ ] **5. Audit the proof** - the before (baseline) run used the published harness and the after run used `{{REPO}}/bin/mm-harness`, both with the same `--library perps=` retained library; both identities are recorded. Open the screenshots under `artifacts/before-fix` (or `baseline`) and `artifacts/after-fix` and confirm they show the claimed state. An unproven claim is a finding.
- [ ] **6. Write `{{TASK_DIR}}/{{REVIEW_FEEDBACK}}`** - use `## Verdict: ISSUES` when any blocking issue or cheap introduced nit remains. Only findings go under `## Issues`:
  ```markdown
  # Review: {{TICKET}}

  ## Verdict: PASS

  ## Summary
  <what changed and whether it is correct>

  ## Validation
  - <recorded CI results, receipts, proof identities and unchecked areas>

  ## Issues
  - **file:line** — description
  ```
- [ ] **7. Complete** - `{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} complete --mark-last`. Do not change source, commits, branches or GitHub.

**Round 3 and later:** block only on blocker or major findings (a real defect in the delta, or an unmet AC). Minors and nits are listed as follow-ups and do not block; with no blocker or major, the verdict is APPROVE.
