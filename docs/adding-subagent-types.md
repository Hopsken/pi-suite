# Adding a subagent type

Pi Suite bundles [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and currently ships one custom type,
`Explore`. Use this guide when adding another type in a later change.

## Define the agent

A subagent type is a Markdown file. Its filename without `.md` becomes the value passed as `subagent_type`; the body is the
system prompt. Optional YAML frontmatter configures the agent:

```markdown
---
description: Security code reviewer
tools: read, grep, find, bash
extensions: false
skills: true
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
prompt_mode: replace
---

Review the requested code for security vulnerabilities. Report findings with file paths, severity, and remediation.
```

Common frontmatter fields include:

- `description` and `display_name` for tool listings and UI;
- `tools` for the built-in tool allowlist;
- `extensions`, `exclude_extensions`, and `disallowed_tools` for extension-tool access;
- `skills` for inherited or preloaded skills;
- `model`, `thinking`, and `max_turns` for execution limits;
- `prompt_mode: replace` for a standalone system prompt or `append` to inherit the parent prompt; and
- `enabled: false` to keep a definition installed but unavailable.

Consult the pinned package's README for the complete field list and current semantics before adding a definition:
`node_modules/@tintinweb/pi-subagents/README.md`.

## Test it locally

Put the Markdown file in one of the directories that Subagents actually scans:

```text
<project>/.pi/agents/<name>.md               # highest priority
<project>/.agents/agents/<name>.md
$PI_CODING_AGENT_DIR/agents/<name>.md        # defaults to ~/.pi/agent/agents/<name>.md
```

Run `/reload`, confirm the type appears under `/agents`, and invoke it through the `Agent` tool. Verify its tool access,
prompt behavior, model fallback, and read-only claims where applicable. A prompt that says "read-only" does not technically
restrict `bash`; omit `bash` if shell access is unnecessary.

Definitions with the same filename override lower-priority definitions. This can replace an upstream type. To disable all
three upstream types while retaining custom definitions, set `disableDefaultAgents: true` in `.pi/subagents.json` or the
global `$PI_CODING_AGENT_DIR/subagents.json`.

## Add it to Pi Suite

Do not add the Markdown file to this repository and assume Pi will discover it from the installed package. Pi package
manifests support extensions, skills, prompts, and themes, but not subagent definitions; `pi-subagents` scans only the three
directories above.

Pi Suite handles delivery through `/setup-agents`, which copies every Markdown file under `presets/agents/` to
`getAgentDir()/agents`. To add a type:

1. Add `presets/agents/<name>.md` using the format above.
2. Add the filename to the expected preset list in `test/distribution.test.ts`.
3. Extend the `/setup-agents` test in `test/index.test.ts` to verify installation and collision behavior.
4. Add the type and its intended use to the README.
5. Run `pnpm check` and `pnpm build`.
6. Inspect `pnpm pack --dry-run --json` to confirm the definition is present in the published artifact.

The installer deliberately preserves existing files, so adding a preset cannot overwrite a user's same-named definition.
It also merges `disableDefaultAgents: true` into the global `subagents.json` without replacing unrelated settings. If
upstream later adds a stable registration API or package-level agent directories, prefer that mechanism over copying files.
