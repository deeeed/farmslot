---
title: Adoption path
---

# Adoption path

Adopting Farmslot should feel like asking an agent to produce better review evidence, not like adopting a whole platform on day one.

The operator only has three decisions:

1. which change needs proof;
2. what evidence would make review easy;
3. whether the agent's recipe and artifacts are trustworthy.

Everything else can be agent-assisted: inspect the project, propose the recipe, choose the runner command, execute it when possible, and package the evidence.

## The short version

1. Pick one review bottleneck.
2. Ask an agent to create a proof recipe for it.
3. Review the proposed setup, actions, assertions, and artifacts.
4. Let the agent run it or explain the missing runner setup.
5. Attach the evidence to the PR.
6. Keep the recipe only if it saves review time.

If that works, deepen the integration. If it does not, stop there.

## Level 0 — Agent writes the proof plan

Start skills-only. No gateway, pool, Command Center, or multi-machine setup is required.

Ask:

> Create a recipe that proves this acceptance criterion is met.

The agent should inspect the project and return:

- the smallest setup needed;
- the real user or system actions to perform;
- the assertions that map to the acceptance criterion;
- the screenshots, logs, traces, or summaries reviewers should see;
- the local command it would run, or the missing command it needs.

This is already useful even before the recipe is executable: it turns vague confidence into a concrete proof contract.

## Level 1 — Run one local recipe

Once the proof plan looks right, add only enough runner support to execute that one recipe repeatedly.

The runner can wrap existing project tooling: Playwright, Jest, pytest, curl, simulator scripts, native test commands, or a small `@farmslot/recipe-harness` command. The important part is the output: a Recipe Protocol v1 evidence package with a summary, trace, and artifact manifest.

Do not model the whole product. Do not add fleet infrastructure. Just prove one behavior.

## Level 2 — Make evidence easy to review

A successful run should answer the reviewer's questions without a meeting:

- What behavior was tested?
- What real actions were performed?
- Which assertions passed or failed?
- Where are the screenshots, logs, traces, or videos?
- Which environment produced the evidence?

At this point, the recipe has earned its keep if it makes one recurring review faster or safer.

## Level 3 — Register project hooks

Only after local recipes are useful, connect the project to Farmslot with `project.json` hooks such as `recipe_run`, `health_check`, and `recycle`.

This lets Command Center or the gateway run the same proof through a managed project slot. The project still owns its commands and fixtures; Farmslot only coordinates the loop.

See [Import a project](./import-a-project.md) and [Project-type onboarding](./project-type-onboarding.md) for the fuller setup.

## Level 4 — Grow into the OS

Adopt the rest only when the workflow needs it:

- multiple isolated slots;
- live watch-and-steer runs;
- cross-runner review;
- mobile supervision;
- retrospectives that improve prompts, recipes, docs, and adapters.

That is the full Farmslot OS path, but it is not the starting point.

## Rule of thumb

If the first adoption step cannot be explained as “the agent made one PR easier to trust,” it is too big.
