---
repo: example-browser
parent: recipe-cook
---

# Generic Browser App Recipe Cook

Use this overlay when the target project is a browser or web app and has no more specific recipe skill.

## Discovery

Start with:

```bash
rg --files | rg 'recipes?/.*\\.json$|validate-recipe\\.(js|mjs|cjs|ts)|playwright|cypress|vitest|agentic-toolkit\\.md'
```

Then inspect package scripts for existing validation surfaces:

```bash
node -e "const p=require('./package.json'); console.log(p.scripts || {})"
```

## Reuse Before Invention

Look for:

- existing recipe files
- browser automation tests
- page objects or stable selectors
- runner/action manifests
- screenshot or trace artifact conventions
- schema validators

## Validation

Use repo-local commands first. Common shapes include:

```bash
node <validate-recipe.js> --recipe <recipe.json> --dry-run
npm test -- --runInBand
```

Live browser validation is optional for first use. When available, record the command, browser control endpoint, artifact directory, and exit status.

If discovery finds no repo-local validator or runner:

- write `validation unavailable: no repo-local validator/runner discovered`
- do not claim that validation passed
