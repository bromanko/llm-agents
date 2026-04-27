# Shared Gas City packs

This directory contains reusable Gas City workflow packs for planning, implementing, reviewing, and coordinating bounded work in consuming repositories. These packs are portable workflow modules, not local runtime city state. Do not store `.gc/`, `.beads/`, local validation cities, generated hooks, or provider runtime files here.

## Layout

- `packs/capabilities/` contains behavior grouped by responsibility.
  - `work-planning` provides work intake, scoping, routing, and small reversible spikes.
  - `work-implementation` provides bounded implementation and review behavior.
- `packs/substrates/` contains tool-specific workflow mechanics.
  - `vcs-jj-workspaces` describes jj workspace-backed implementation and parallel batches.
- `packs/workflows/` composes capabilities and substrates into ready-to-import workflows.
  - `planned-work-jj` exports planning, implementation, and jj workspace support together.

A future `repo-coordination` capability may capture generic multi-repository coordination, but that is intentionally not part of this first shared pack extraction.

## Importing the workflow

A consuming repository can import the composed workflow pack from a local checkout:

```toml
[imports.planned_work_jj]
source = "../llm-agents/gascity/packs/workflows/planned-work-jj"
export = true
```

The repository root also contains a convenience `pack.toml` that exports the same workflow:

```toml
[imports.shared_work]
source = "../llm-agents"
export = true
```

Remote import syntax and pinning should be validated against the Gas City version used by the consumer before a checked-in configuration depends on it.

## Consumer responsibilities

Consuming repositories keep their own domain adapters, local operating model, product or platform vocabulary, and source-control authority rules. Shared packs provide neutral work-oriented behavior; consumers decide which formulas and agents to re-export, and whether compatibility adapters are needed for existing local names or variables.

Shared formulas assume source-control authority is explicit. A source task or plan should say whether workers have no commit authority, local checkpoint commit authority, or integration/finish authority. If checkpoint commits are delegated, workers should commit coherent in-progress work at task or gate boundaries and report commit hashes with verification status.

Shared agents should leave durable progress breadcrumbs on the source task and use the consuming repository's attention channel for blockers, review-ready handoffs, checkpoint commits, and human gates. If hook delivery appears broken, agents should record that fact and use an explicit mail/nudge or equivalent fallback rather than staying silent.

Low-level workspace lifecycle commands such as `/ws-create`, `/ws-list`, `/ws-switch`, and `/ws-finish` come from the user's workspace extension. These Gas City packs only describe when and how to use those commands; they do not implement command handlers.
