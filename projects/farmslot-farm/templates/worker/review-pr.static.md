---
platforms: [cli]
description: Apply the canonical Farmslot review guidance in a frozen source workspace.
---

# Farmslot static review

The gateway supplies the frozen source, canonical review guidance and result contract. This stage inspects source and retained evidence; execution checks belong to separate QA.

Static review reads source, the diff, recorded evidence, existing CI results and deterministic receipts only. Tests and code validation belong to CI. Do not run tests, builds, recipes, installs, probes or ad hoc validation scripts. A claim without evidence is a finding or marked unverified.

## Checklist

- [ ] Read the task's frozen subject, PR context, repository instructions and instruction manifest. Apply the canonical review guidance listed in that manifest.
- [ ] Inspect the diff and relevant callers against those rules and the authorized scope. Write concrete findings, evidence limits and the exact reviewed head in `artifacts/review.md`, `artifacts/learnings.md`, `artifacts/line-comments.json` and the task's declared typed result.
- [ ] From the task directory supplied in the launch prompt, run `./mark complete --mark-last`.
