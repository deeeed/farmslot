---
title: Adoption path
---

# Adoption path

Teams do not need to adopt the full Farmslot OS first. Start with the smallest slice of the [operating loop](../concepts/operating-loop.md) that creates trust: a recipe, a proof artifact, and a human decision. The planned [Recipe skills adoption kit](./recipe-skills-adoption.md) is the lowest-friction entry point: install the skills, create one useful recipe, and grow into the harness or Command Center only after the value is clear.

## Step 0 — Start recipe-first

The first adoption path should be skills-only or recipe-only:

- install the planned `@farmslot/skills` package;
- ask the agent to write a proof recipe for one acceptance criterion;
- review the proposed setup, actions, assertions, and artifacts;
- add a runner only when the recipe is worth executing repeatedly.

## Step 1 — Pick one review bottleneck

Choose one flow where review currently depends on manual confidence:

- a recurring bug fix;
- a brittle end-to-end test;
- a high-risk UI behavior;
- an acceptance criterion reviewers often ask to see.

## Step 2 — Define the proof artifact

Before adding automation, decide what evidence would make the change easy to approve:

- screenshot, video, trace, log, or structured assertion;
- before/after comparison;
- exact environment or slot context;
- pass/fail signal that maps to the acceptance criteria.

## Step 3 — Add one narrow recipe

Keep the first recipe small. The goal is to produce useful evidence, not to model the whole product. See [Write a recipe](./write-a-recipe.md) for the recipe shape and JSON example.

## Step 4 — Run through a project runner

The project runner may call the shared Farmslot harness directly or wrap existing native tooling. What matters is that it emits the v1 evidence package.

## Step 5 — Attach evidence to review

A successful recipe run should make the PR easier to review:

- the reviewer can see what was tested;
- screenshots/video/logs are linked from the artifact manifest;
- failed assertions point to the exact step that broke.

## Step 6 — Reuse and expand

Once the first recipe proves useful, keep it as a reusable validation asset. Then expand toward more of the loop: dispatch discipline, live observability, cross-runner review, and replay/eval data.
