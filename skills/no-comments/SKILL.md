---
name: no-comments
description: "Review comments with a fresh subagent, fix accepted findings, and offer encodings for claimed constraints. Use for /skill:no-comments or when asked to remove unnecessary comments."
disable-model-invocation: true
---

# No comments

Spawn a comment reviewer. Act on accepted findings.

Defer to the reviewer's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn a general subagent using the current harness's delegation tools. Pass the scope and the full [comment review rules](references/comment-review.md). The subagent may edit comments within scope, but must not edit application code. Use the harness's configured model; no named agent definition is required.
2. Inspect its report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, use the **how** or **why** skill on their symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. Revert only the rejected reviewer's edits and rerun one rejected report with the failure named. Reject a second, report it open, and fail the review.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, sketch the design once for the accepted set and surrounding code. Stop at the sketch. Step 4 implements.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The [fix-root-causes](../principles/references/fix-root-causes.md) and [redesign-from-first-principles](../principles/references/redesign-from-first-principles.md) references guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Constraint comments say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. Offer the cheapest in-scope type, runtime, test, or CI lint. Wait for interactive approval. Unattended and eval require caller pre-approval. If approved, encode then delete. Otherwise delete, report the constraint open, and sketch out-of-scope work.
6. Report the deletion count, restored comments, reruns, design sketch, fixes, encoding offers, encodings, unenforced constraints, and other open work.
