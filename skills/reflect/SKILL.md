---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/skill:reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, use the current harness's history tools or session records to read this conversation. Don't read another project's conversations without being asked. If the transcript is unavailable, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Spawn three subagents concurrently using the current harness's delegation tools. Reviewers need access to the available MCP tools for the tickets, chat threads, and observability traces the transcript references. They must not modify files or external state.

Use the harness's configured models for the reviewers and synthesizer.

| Lens | Prompt template |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript reference or digest where marked. Reviewers return findings in their response body.

## 3. Synthesize

Spawn one synthesizer with access to the available MCP tools to spot-verify citations. It must not modify files or external state. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the [encode-lessons-in-structure](../principles/references/encode-lessons-in-structure.md) reference in **principles**.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `plugins/cache/`. Before approval, show its destination, `.agents/skills/<skill>/` or `~/.agents/skills/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): use available skill-authoring guidance and run a draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): use available skill-authoring guidance and run a description-optimization loop.
- `new skill: <kebab-name>`: use available skill-authoring guidance. Write a `SKILL.md` with YAML frontmatter containing `name` and `description`; the name must match its parent directory.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
