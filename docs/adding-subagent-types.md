# Adding a subagent type

Pi Suite bundles [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) and ships three custom types:
`Explore`, whose isolated read-only context provides finder-style codebase discovery without filling the parent agent's
context with intermediate searches; `Librarian`, which uses Web Access for authoritative source-code research outside the
local workspace; and `Oracle`, which provides an independent expert second opinion through GPT-5.6 Sol with high thinking.
Oracle selectively loads Pi Suite, Subagents, and Web Access so it can delegate focused repository discovery through
`oracle_finder`, delegate authoritative external source-code research through `oracle_librarian`, and retrieve
narrow external evidence without inheriting unrelated extension tools. Use this guide when adding another type in a later
change.

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
`pi-suite` or `pi-subagents`; it remains available as the fixed spawn target of Oracle's scoped Librarian adapter.

## Scope recursive delegation to specific research subagents

`pi-subagents` deliberately removes its own `Agent`, `get_subagent_result`, and `steer_subagent` tools from every child
session, even when selected in frontmatter. This prevents unrestricted recursive spawning. Oracle still needs Finder-like
local repository discovery and deep external source-code research, so Pi Suite provides two narrow exceptions:
`oracle_finder` can launch only the read-only `Explore` type, while `oracle_librarian` can launch only the
read-only `Librarian` type. Neither tool accepts a child type or model parameter. This does not weaken or patch the upstream
recursion guard.

```text
Main Pi agent                         Oracle child                       Research child
┌──────────────────┐   Agent tool    ┌────────────────────┐ fixed tool  ┌──────────────────┐
│ No Oracle        │───────────────▶│ oracle_finder      │────────────▶│ Explore: local   │
│ research tools   │                │ oracle_librarian   │────────────▶│ Librarian:       │
│ or schemas       │◀───────────────│                    │◀────────────│ external source  │
└──────────────────┘ Oracle answer  └────────────────────┘ evidence     └──────────────────┘
```

### Select the tool explicitly

Oracle's frontmatter loads Pi Suite, Subagents, and Web Access, then uses `ext:` selectors to expose only the intended tools
from those extensions:

```yaml
tools: "*, ext:pi-suite/oracle_finder, ext:pi-suite/oracle_librarian, ext:pi-web-access/web_search, ext:pi-web-access/fetch_content, ext:pi-web-access/get_search_content"
disallowed_tools: edit, write
extensions: [pi-suite, pi-subagents, pi-web-access]
skills: false
```

Loading an extension and exposing its tools are separate decisions. `extensions:` lets Pi Suite initialize inside the child;
The two `ext:pi-suite/` selectors add only the fixed Explore and Librarian adapters to Oracle's eventual active set.
Subagents' own recursive tools remain hard-excluded by upstream code.

### Register after identifying the child

Do not register a scoped tool in the Pi Suite extension factory. The same factory runs for the main session and during child
extension discovery, so eager registration would put the tool in the main agent's registry and model-facing tool schema.

Subagents includes an identity marker in every generated child system prompt for downstream policy extensions. Oracle uses
`prompt_mode: replace`, which places that marker at the beginning:

```xml
<active_agent name="Oracle"/>
```

Pi Suite checks that marker during `session_start` and calls `registerTool` only in the matching Oracle extension runtime.
A normal main session has no marker, so neither Oracle research tool is registered there. This is schema isolation rather
than an execution-time rejection: the main model cannot see or call either tool.

The lifecycle ordering is important:

1. Subagents creates a child resource loader and loads the selected extensions.
2. It builds the child prompt, including the `<active_agent>` marker.
3. It binds surviving extensions, which fires `session_start`; Pi Suite now registers both Oracle research tools.
4. After binding, Subagents derives the active extension-tool set from the loader's live tool maps. This picks up the
   late-registered adapter and applies Oracle's `ext:` narrowing before the first model turn.

Registering later than `session_start`, or narrowing from a stale snapshot taken before extension binding, would leave the
tool unavailable to Oracle. Registering earlier would expose it to the main loop.

### Delegate through child-local RPC

The adapter cannot call the removed `Agent` tool directly. Instead, it uses `pi.events` as a child-local RPC channel to the
surviving Pi Subagents extension:

1. Generate a unique request ID and subscribe to its spawn-reply channel plus `subagents:completed` and
   `subagents:failed`.
2. Emit `subagents:rpc:spawn` with the adapter's type hard-coded to `Explore` or `Librarian`, `inheritContext: false`, and
   foreground execution.
3. Wait for the child result and return only its distilled output to Oracle.
4. On cancellation, emit `subagents:rpc:stop`; on failure, propagate the child error; in every terminal path, remove event
   listeners and timers.

Terminal events can arrive before the spawn reply under fast completion, so the adapter temporarily buffers unmatched
terminal events by agent ID and consumes the matching one after the reply identifies the spawned child. Unique request and
agent IDs keep concurrent Oracle research calls isolated.

The resulting boundary is intentionally narrower than general recursive delegation:

- each adapter accepts no child type or model parameter and can spawn only its named `Explore` or `Librarian` child;
- neither child inherits Oracle's conversation; Explore returns distilled local evidence and Librarian returns a
  self-contained external research answer rather than a second judgment;
- Oracle remains responsible for interpreting the findings and producing the final recommendation;
- `edit` and `write` are structurally denied for Oracle, while Explore exposes only read-oriented built-ins; and
- the main Pi agent has no Oracle research registration, active tool, or tool schema.

Keep tests for both sides of the boundary: a normal session must not register either research tool, an Oracle-marked session
must register both, each tool must spawn only its fixed child type, and Subagents' real scope parser must resolve Oracle's
final tool set without its generic recursive tools. If upstream adds a first-class per-agent tool registration or
constrained-delegation API, prefer it over these adapters.

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

The installer deliberately preserves existing files, so adding a preset cannot overwrite a user's same-named definition.
It also merges `disableDefaultAgents: true` into the global `subagents.json` without replacing unrelated settings. If
upstream later adds a stable registration API or package-level agent directories, prefer that mechanism over copying files.
