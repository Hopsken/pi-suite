---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /skill:swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Keep a checklist with one entry per phase before launching anything. Use the current harness's planning tool when available, or a short in-chat checklist.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Use the current harness's configured worker models unless the user specifies otherwise. Inspect the available delegation tools before choosing model, reasoning, speed, or execution options; do not assume these are selectable. For a model race, name each arm's supported model up front. If the harness cannot select or confirm the required models, report that limitation rather than claiming a cross-model race.
4. Give each worker its own writable output when it writes. In a shared checkout, assign disjoint files and make shared dependencies read-only. Workers racing on the same code need separate working copies or must return proposals without editing. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.
5. Establish what code and environment each worker will see. Prefer the current workspace when the task needs its local state. Separate working copies do not automatically contain uncommitted changes, local commits, running services, or credentials. Make the required revision and local changes available before launch; do not assume a branch name transfers them. Account for setup and tool side effects, including automatic commits, within the user's authorization.

## Phase B: Fan out

Use the current harness's native subagent tools: `Task` in Amp or `Agent` in Pi Suite when available. Follow their current schemas and instructions; do not copy parameters between harnesses. Do not create separate conversations or cloud environments merely to obtain parallelism when subagents can do the work.

Launch independent workers together using the supported parallel or background mechanism, within the harness's concurrency limits. Track each returned worker ID and its slice or race arm. Use asynchronous execution when there is independent work to do while workers run; otherwise use the supported blocking parallel mechanism.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. State whether the worker may edit, which files it owns, and what must not change. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

Collect results through the harness's supported completion notifications, result tools, or blocking returns. A launch acknowledgement, timeout, or partial notification is not a terminal result. Follow the harness's waiting rules; if it requires yielding for background results, resume aggregation when those results arrive.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Inspect the evidence and any changed files before accepting a result. Integrate accepted changes in the parent workspace and run the relevant checks on the combined result. A worker's `PASS` is not proof that its changes work with the other workers' changes.

Account for every launched worker before the final report. For a first-pass race, stop remaining workers with the harness's supported controls when available, or let them finish. Preserve and identify any partial edits; do not assume stopping a worker rolls them back. Report any worker still running and do not claim the swarm is drained while it can still change the output.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used. State which changes were accepted, what combined verification ran, and any remaining work or harness limitations.
