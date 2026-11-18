# Changelog

## Unreleased

- Declare the FSR rules as a level-2 review rule pack (ADR-0073 Amendment 1). `fixtures/runtime/review-pack.json` is generated from `review-quality.md` by `scripts/review-pack.mjs`, with one family per FSR rule and its recorded failure as the cause. `required_skills` freezes both files for every flow, so a task's TASK.md now lists `review-quality.md` under Required skills, and task init refuses a missing or invalid pack.

- Select the sole QA profile automatically.

- Use the resolved publication base for PR follow-up and branch-update rebases.

- Bind configured recipe runs to their task and use shared recipe proof instructions with fresh retained direct-replay attempts.

- Use engine-derived attempt evidence and gateway publication; remove project evidence sync and direct PR uploads.
- Default all new run and reviewer model settings to Opus.
