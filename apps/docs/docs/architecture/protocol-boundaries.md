---
title: Protocol boundaries
---

# Protocol boundaries

The protocol boundary exists so Farmslot can understand proof from many projects without owning each project's runtime details.

## Farmslot owns

- dispatch and slot lifecycle;
- Recipe v1 validation;
- generic trace, summary, and artifact manifest expectations;
- evidence viewing, replay, grading, and human gates.

## Projects own

- native app setup;
- selectors, fixtures, target discovery, and debug bridges;
- custom action semantics;
- product-specific assertions;
- mapping acceptance criteria to reusable recipes.

## Adapter rule

A custom action should be valid only when both conditions are true:

1. the action appears in the project action manifest;
2. the runner registers an adapter that implements it.

That keeps the recipe graph explicit while still allowing project-native behavior.
