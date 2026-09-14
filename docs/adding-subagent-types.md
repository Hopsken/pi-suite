# Adding a subagent type

Pi Suite bundles [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and ships three custom types:
`Explore`, whose isolated read-only context provides finder-style codebase discovery without filling the parent agent's
context with intermediate searches; `Librarian`, which uses Web Access for authoritative source-code research outside the
local workspace; and `Oracle`, which provides an independent expert second opinion through GPT-5.6 Sol with high thinking.
Oracle loads Pi Suite and Web Access and receives native, manager-scoped `Agent` tools for delegating to Explore and
Librarian; it does not load the Subagents extension inside its own session. Use this guide when adding another type in a
later change.

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
- `extensions` for what loads, `tools: ext:<extension>/<tool>` for which extension tools surface, and
  `exclude_extensions` or `disallowed_tools` for explicit denials;
- `skills` for inherited or preloaded skills;
- `model`, `thinking`, and `max_turns` for execution limits;
- `run_in_background`, `persist_session`, and `output_transcript` for execution and retention behavior;
- `inherit_context` for caller-context inheritance and `allowed_subagents` for native, scoped nesting;
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

## Separate local discovery from external research

Explore owns first-party codebase discovery. Librarian owns deep understanding of authoritative repositories outside the
local workspace, including upstream dependencies whose vendored or `node_modules` copy is incomplete. Keep those roles
separate in their descriptions and prompts so the parent selects the source of truth rather than treating both as generic
search agents.

Librarian loads only Web Access and explicitly exposes its three research tools alongside read-oriented built-ins:

```yaml
tools: "read, bash, grep, find, ls, ext:pi-web-access/web_search, ext:pi-web-access/fetch_content, ext:pi-web-access/get_search_content"
extensions: [pi-web-access]
skills: true
```

`fetch_content` turns a known GitHub URL into a managed clone under `/tmp/pi-github-repos/<owner>/<repo>` or an API-backed
view for an oversized repository. Librarian follows a clone-first workflow and searches that local copy with `rg`, read,
and Git history commands instead of repeatedly fetching individual pages. This tool-managed retrieval state is compatible
with Librarian's logical read-only role, but Bash remains prompt-enforced rather than sandboxed. The prompt forbids shell
cloning, network commands, and workspace inspection as an authoritative source. It also requires `web_search` calls to set
`workflow: "none"`; the default summary-review workflow opens an interactive curator, which is inappropriate inside an
autonomous child session.

Librarian keeps `skills: true` so user-installed repository-research skills can contribute authenticated read-only sources,
for example through a configured Sourcegraph CLI. The curated prompt remains the source of Librarian's role and safety
boundary; inherited skills provide workflows, not a replacement identity. Pi Suite still does not register
`pi-web-access`'s bundled Librarian skill. Librarian's own child session does not recursively delegate, so it does not load
`pi-suite` or `pi-subagents`; it remains available to Oracle through native scoped nesting.

## Scope native nested delegation

Oracle uses the manager's native nesting. Its frontmatter sets `allowed_subagents: [Explore, Librarian]`; the manager
supplies scoped `Agent` tools for exactly those types, and the allowlist prevents Oracle from spawning itself. Oracle does
not load `pi-subagents` inside its child session:

```yaml
tools: "read, bash, grep, find, ls, ext:pi-suite/session_search, ext:pi-suite/session_read, ext:pi-web-access/web_search, ext:pi-web-access/fetch_content, ext:pi-web-access/get_search_content"
disallowed_tools: edit, write
extensions: [pi-suite, pi-web-access]
skills: false
allowed_subagents: [Explore, Librarian]
```

This leaves Oracle with read-only built-ins, the two history tools, the three Web Access tools, and manager-provided scoped
delegation. Keep the global `maxSubagentDepth: 2` limit and test both the allowlist and depth boundary. Explore and Librarian
must not declare nested subagents. Oracle interprets their evidence; the parent implements and verifies its recommendation.

## Execution and retention defaults

Suite setup globally sets `disableDefaultAgents: true`, `backgroundByDefault: false`, `rememberAgents: false`,
`workflowsEnabled: false`, `schedulingEnabled: false`, `maxSubagentDepth: 2`, and `outputTranscript: false`. These are
lower-priority global settings; project settings can override them. Scheduling is disabled, and the `Agent` tool has no
`schedule` parameter after reloading the extension.

Every suite preset sets `run_in_background: false` as a hard override, including when a caller explicitly requests `true`.
Blocking execution returns the result directly and avoids a redundant completion turn. All three presets set
`persist_session: false` and `output_transcript: false`; their own sessions and separate `.output` transcript files are not
retained, while their results remain in the caller session and Web Access caching remains enabled. To retain an agent's
sessions for `session_search`, set `persist_session: true` in its installed preset and run `/reload`. Explore additionally
sets `inherit_context: false`.

## Add it to Pi Suite

Do not add the Markdown file to this repository and assume Pi will discover it from the installed package. Pi package
manifests support extensions, skills, prompts, and themes, but not subagent definitions; `pi-subagents` scans only the three
directories above.

Pi Suite handles delivery through **Setup agents** in `/suite`, which copies every Markdown file under `presets/agents/` to
`getAgentDir()/agents`. To add a type:

1. Add `presets/agents/<name>.md` using the format above.
2. Add the filename to the expected preset list in `test/distribution.test.ts`.
3. Extend the `/suite` setup-agents test in `test/index.test.ts` to verify installation and collision behavior.
4. Add the type and its intended use to the README.
5. Run `pnpm check` and `pnpm build`.
6. Inspect `pnpm pack --dry-run --json` to confirm the definition is present in the published artifact.

Suite updates already-installed global presets during extension activation, before the bundled Subagents extension reads
them. Startup and `/reload` replace a preset only when its bundled content hash differs from the revision recorded in
`getAgentDir()/.pi-suite-presets.json`. Existing same-named presets without a recorded revision are migrated too. Every
replacement first saves the old file under `getAgentDir()/pi-suite-agent-backups/update-*/`, outside agent discovery paths;
if backup fails, the old preset remains untouched. Reapply desired custom edits after an update. Normal reloads preserve
those edits until the bundled content changes again.

Automatic updates leave unrelated agents, project-local definitions, and `subagents.json` unchanged. They do not install
missing or deleted presets. Setup installs missing presets, updates old ones, and merges the suite's global defaults into
`subagents.json` without replacing unrelated settings. Keep Suite before Subagents in the package extension list so updated
presets take effect on the same startup or reload. If upstream later adds a stable registration API or package-level agent
directories, prefer that mechanism over copying files.
