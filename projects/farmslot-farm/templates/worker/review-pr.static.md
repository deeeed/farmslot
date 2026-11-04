---
platforms: [cli]
description: Apply the canonical Farmslot review guidance in a frozen source workspace.
---

# Farmslot static review

The gateway supplies the frozen source, canonical review guidance and result contract. This stage inspects source and retained evidence; execution checks belong to separate QA.

## Checklist

- [ ] Read the task's frozen subject, PR context, repository instructions and instruction manifest. Apply the canonical review guidance listed in that manifest.
- [ ] Inspect the diff and relevant callers against those rules and the authorized scope. Write concrete findings, evidence limits and the exact reviewed head in `artifacts/review.md`, `artifacts/learnings.md`, `artifacts/line-comments.json` and the task's declared typed result.
- [ ] From the task directory supplied in the launch prompt, run `./mark complete --mark-last`.
