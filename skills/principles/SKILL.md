---
name: principles
description: "Engineering principles for design, debugging, refactoring, testing, verification, and autonomous execution. Use for /skill:principles or when choosing how to approach a task, reviewing a design, or responding to a recurring mistake."
disable-model-invocation: true
---

# Principles

Choose the principles that apply to the current task from the index below, then read those references before applying them. Do not load every reference by default.

Each reference preserves the original principle's description and instructions. Its frontmatter is source metadata, not a separate skill registration. Follow links to related principles when needed. Apply each principle within its stated scope and the user's task, permissions, and repository guidance.

## Design and ownership

- [Experience First](references/experience-first.md): product, UX, and feature-scope tradeoffs.
- [Exhaust the Design Space](references/exhaust-the-design-space.md): novel UI interactions or architectural decisions without a local precedent.
- [Foundational Thinking](references/foundational-thinking.md): core types, data structures, and the order of foundational work.
- [Model the Domain](references/model-the-domain.md): stateful logic, repeated shape assumptions, and growing conditionals.
- [Boundary Discipline](references/boundary-discipline.md): validation, error handling, and framework adapters.
- [Type System Discipline](references/type-system-discipline.md): illegal states, semantic types, external data, and exhaustive variants.
- [Separate Before Serializing Shared State](references/separate-before-serializing-shared-state.md): concurrent actors writing shared state.
- [Make Operations Idempotent](references/make-operations-idempotent.md): commands and lifecycle steps exposed to crashes, restarts, and retries.

## Simplification and change

- [Subtract Before You Add](references/subtract-before-you-add.md): sequence an addition, refactor, or rewrite.
- [Laziness Protocol](references/laziness-protocol.md): minimize changes and avoid unnecessary abstractions.
- [Minimize Reader Load](references/minimize-reader-load.md): reduce layers to trace and state to remember.
- [Redesign From First Principles](references/redesign-from-first-principles.md): integrate a new requirement into an existing design.
- [Migrate Callers Then Delete Legacy APIs](references/migrate-callers-then-delete-legacy-apis.md): replace internal APIs without keeping compatibility layers.
- [Outcome-Oriented Execution](references/outcome-oriented-execution.md): planned rewrites and migrations with explicit verification boundaries.

## Debugging and proof

- [Fix Root Causes](references/fix-root-causes.md): trace a symptom to the first fault.
- [Attack the Premise](references/attack-the-premise.md): repeated fixes fail while sharing the same assumption.
- [Explain the Number](references/explain-the-number.md): verify what a performance measurement or evaluation result means.
- [Test Behavior, Not Implementation](references/test-behavior-not-implementation.md): write, change, or retain a test.
- [Prove It Works](references/prove-it-works.md): check the real output before declaring completion.

## Execution and learning

- [Build the Lever](references/build-the-lever.md): make non-trivial work repeatable and reviewable.
- [Sequence Work Into Verifiable Units](references/sequence-verifiable-units.md): divide multi-step work and delivery into checked increments.
- [Guard the Context Window](references/guard-the-context-window.md): manage large outputs, long files, and delegation.
- [Never Block on the Human](references/never-block-on-the-human.md): proceed with reversible work while respecting approval boundaries.
- [Encode Lessons in Structure](references/encode-lessons-in-structure.md): turn repeated corrections into enforceable rules.

## Related skills

The references also mention [show-me-your-work](../show-me-your-work/SKILL.md), [benchmark-checklist](../benchmark-checklist/SKILL.md), and [typescript-best-practices](../typescript-best-practices/SKILL.md). Read them when the task needs their procedures.
