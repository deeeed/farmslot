# Changelog

## Unreleased

- Declare the FSR review rule pack at level 2 on the static review (`static_review.rule_pack`). The review validates `runtime/review-pack.json` from the farm installation, freezes it with its digest in the handoff, and refuses a missing or invalid pack. Reviewed branches are not involved.

- Generate the FSR rules as a review rule pack (ADR-0073 Amendment 1). `fixtures/runtime/review-pack.json` is generated from `review-quality.md` by `scripts/review-pack.mjs`, with one family per FSR rule, anchored by `<a id="fsr-nn"></a>`, and its recorded failure as the cause. A project-hook test keeps the pack in sync. The farm does not declare the pack yet; that waits for a project-level declaration, because these rules come from the farm installation, not from the reviewed checkout.

- Select the sole QA profile automatically.

- Use the resolved publication base for PR follow-up and branch-update rebases.

- Bind configured recipe runs to their task and use shared recipe proof instructions with fresh retained direct-replay attempts.

- Use engine-derived attempt evidence and gateway publication; remove project evidence sync and direct PR uploads.
- Default all new run and reviewer model settings to Opus.
