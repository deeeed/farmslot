---
name: ci-parity-check
description: Checklist-shaped skill used as a child unit by the sub-task E2E.
---

# CI parity check

A checklist-shaped skill: sections plus `- [ ]` rows, exactly what a child unit
needs. The `## Rules` section below is informational, so its box is never a step.

## Rules

- [ ] Never push before the parity gate is green.

## Parity gate

- [ ] **1. Read the failing job output referenced from {{TASK_DIR}}**
- [ ] **2. Reproduce the failure with the repo's canonical lint command**
- [ ] **3. Record the parity result under {{TASK_DIR}}/artifacts**
