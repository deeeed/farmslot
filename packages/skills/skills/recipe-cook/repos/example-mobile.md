---
repo: example-mobile
parent: recipe-cook
---

# Generic Mobile App Recipe Cook

Use this overlay when the target project is a mobile app and has no more specific recipe skill.

## Discovery

Start with:

```bash
rg --files | rg 'recipes?/.*\\.json$|validate-recipe\\.(sh|js|mjs|cjs|ts)|detox|maestro|appium|testIds?|accessibility|agentic-toolkit\\.md'
```

Then inspect package scripts for local test and validation commands:

```bash
node -e "const p=require('./package.json'); console.log(p.scripts || {})"
```

## Cooking Rules

- Prefer stable accessibility labels, test IDs, or existing mobile automation when it exists.
- Keep proof targets separate from platform mechanics.
- Do not import web-only selectors or desktop assumptions into mobile recipes.
- If mobile lacks a repo-owned helper, write a recipe and proof plan, then mark live validation unavailable with the concrete blocker.

## Validation

Use repo-local commands first. Common shapes include:

```bash
bash <validate-recipe.sh> <artifacts-dir> --dry-run
node <validate-recipe.js> --recipe <recipe.json> --dry-run
npm test
```

Live device or simulator validation is optional for first use. When available, record the device/simulator target, command, artifact directory, and exit status.

If discovery finds no repo-local validator or runner:

- write `validation unavailable: no repo-local validator/runner discovered`
- do not claim that validation passed

## Mobile-Specific Caution

Keep stable across platforms:

- proof target meaning
- proof mode (`state`, `visual`, `mixed`)
- honest unresolved-target reporting

Allow to differ by platform:

- selectors
- navigation steps
- runtime validation commands
- artifact capture mechanics
