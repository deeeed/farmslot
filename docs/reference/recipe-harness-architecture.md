# Recipe harness architecture

This document records component boundaries. [Recipe Protocol v1](recipe-protocol-v1.md) is the field-level authority.

## Design

The harness is a small protocol executor between a recipe and project-owned capabilities:

```text
CLI / Farmslot gateway / Command Center
                  │
          recipe harness
   ┌──────────────┼──────────────┐
validator      resolver       executor
   │              │              │
protocol      libraries       adapters
                                  │
                       browser / mobile / core
```

The same validator and executor handle root and called recipes. Composition does not introduce a second artifact type or execution path.

## Responsibilities

### Protocol

- validates the canonical recipe root and workflow graph;
- applies parameter defaults before validation;
- requires static `call.ref` values and explicit `call.params` boundaries;
- verifies reachability, acyclicity, result cases, proof coverage, and teardown separation;
- validates action manifests and artifact packages.

### Resolver

- indexes ordered library sources with deterministic precedence;
- selects adapter variants without changing recipe identity;
- resolves the full dependency DAG before side effects;
- rejects missing refs, cycles, unsafe paths, invalid parameters, and excessive depth;
- writes exact resolution provenance.

### Executor

- resolves parameters and prior-node outputs;
- executes one declared action at a time;
- owns routing from `next`, `cases`, and `default`;
- always enters declared teardown after main success or failure;
- records nested trace and evidence without leaking child state into the parent.

### Adapters

- implement only manifest-declared actions;
- return output, observations, artifacts, and an optional declared result case;
- never choose a graph destination or final recipe verdict;
- keep product-specific behavior in namespaced actions.

### Surfaces

- CLI exposes compact discovery, plan, execution, and machine-readable results;
- gateway transports the same commands and artifacts across slots;
- Command Center renders the same graph, intent, progress, and evidence.

## Trust boundary

Before execution, approval binds the complete recipe DAG, adapter implementations, declared capabilities, project root, environment, parameters, and artifact destination. A trusted caller cannot grant undeclared capability to an untrusted dependency.

Custom adapter implementations are code. Treat their digest and capability declarations as part of the execution plan. Recipe source precedence never changes this rule.

## Extension points

Projects extend the system with:

1. strict namespaced action declarations and implementations;
2. adapter-specific variants of the same recipe id;
3. ordered recipe libraries;
4. project hooks that launch or verify the runtime.

Do not extend the protocol for domain vocabulary, convenience wrappers, retry policy, or product state. Encode reusable domain behavior as a parameterized recipe; keep bounded polling inside the action that owns it.

## Non-goals

- replacing project-native unit or integration tests;
- embedding product controllers in Farmslot;
- preserving pre-v1 recipe formats;
- generating evidence the runtime did not actually observe.
