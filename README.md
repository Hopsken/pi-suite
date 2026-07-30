# pi-suite

An opinionated [Pi coding agent](https://pi.dev) distribution curated to provide an AmpCode-level developer experience.

`pi-suite` is one installable Pi package that combines:

- a deliberately selected and pinned set of third-party Pi packages;
- custom extensions for workflows that are missing or work differently in upstream Pi; and
- cohesive defaults that make the individual pieces feel like one product rather than a bag of plugins.

The suite favors strong defaults, low configuration overhead, and polished interactive workflows. New dependencies are
included only when they materially improve the coding-agent experience.

## Included

### Custom extensions

#### CLI tool discovery

Pi Suite detects commonly used CLI tools when a session starts and appends the available commands to the
agent's system prompt. This gives the agent an immediate view of useful environment capabilities without spending Bash
calls on discovery. Detection covers tmux, ffmpeg, jq, Docker, fzf, unzip, lsof, zstd, websocat, ripgrep, ast-grep, Bun,
pnpm, Yarn, agent-browser, mise, asdf, the Nix CLI, the GitHub CLI, and the GitLab CLI. Availability does not imply that a
tool is configured or that a related service, such as the Docker daemon, is running. Discovery uses Pi's configured
`shellPath` and `shellCommandPrefix`, including merged project settings, so it sees the same command environment as Pi's
Bash tool.

#### Tool selector

The package adds `/tools`, an interactive list of every available tool. Toggle tools between **enabled** and **disabled**
to change the active tool set immediately. The selection is stored in the current session branch, restored after reloads,
and follows branch navigation; tools that are no longer available are discarded when restoring a saved selection.

#### Compaction model

The package adds `/suite`, an interactive configuration menu. Its **Compaction model** item selects a dedicated model and
thinking level for session compaction without changing the active conversation model.

The selection is stored in `~/.pi/agent/pi-suite.json` as one `compactionModel` value in `<model-id>:<thinking>` format, so
it persists across new and resumed sessions. Choose **Use active session model (default)** to reset it.

Compaction continues to use Pi's native implementation, including its prompts, structured summaries, cut-point and recent
message retention, split-turn handling, iterative summaries, file-operation tracking, and `/compact` instructions. If the
selected model disappears, cannot authenticate, or fails, Pi falls back to the active session model.

Only authenticated models are shown. The searchable picker matches provider names, model IDs, and human-readable model
names. The thinking-level picker is limited to levels supported by the selected model.

> Pi currently authenticates the active conversation model before running compaction hooks. The active model therefore
> still needs valid authentication even when a dedicated compaction model is selected.

#### Historical session search and read

Pi Suite adds two tools for recovering evidence from earlier Pi sessions without injecting history automatically:

- `session_search` performs deterministic local search and returns session metadata plus short active-branch snippets.
- `session_read` answers one focused question from a selected session with entry-level evidence citations.

Search covers sessions from **all historical working directories by default**. Every result includes its source cwd. Add
`cwd:.` when the question must be restricted to the exact current directory. The executing session is always excluded.
Search responses include `count` and `hasMore`; `hasMore` indicates that the caller can increase `limit` or narrow the query
to retrieve additional matches.

Examples:

```text
"refresh token" cwd:. after:30d
"connection pool" tool:bash
file:src/auth.ts model:openai-codex/gpt-5.6-terra
id:019abc
```

Bare terms, quoted phrases, and `id:`, `name:`, `cwd:`, date, `model:`, `tool:`, and `file:` filters compose with AND
semantics. `file:` uses only structured paths from Pi's read, write, edit, and compaction records; it does not infer file
access from shell commands or conversational mentions.

Use the **Session reader model** item in `/suite` to choose the model and supported thinking level used by `session_read`.
The selection is stored in `~/.pi/agent/pi-suite.json` as one `sessionReadModel` value in `<model-id>:<thinking>` format.
**Use active session model (default)** follows the invoking session's model and thinking level. An explicitly configured
model fails closed if it disappears or cannot authenticate; historical content is never silently sent to another model.

Both tools use Pi's public `SessionManager` for discovery, opening, compatibility, and persisted leaf semantics. Opening an
older session can therefore run Pi's normal migration and rewrite. The extension does not otherwise switch, append to,
branch, edit, or compact historical sessions, and it creates no persistent search index. Search and read use only the
active branch, but `session_read` includes original active-path evidence that predates compaction.

Pi Suite projects visible historical text and structured tool arguments as they were persisted; it does not redact session
content. Images, thinking, signatures, provider diagnostics, hidden messages, and opaque extension state remain outside the
tools' evidence model. Reader inference is tool-free and treats historical content as untrusted evidence.

### Pi reports "Nothing to compact"

Pi checks whether any persisted conversation entries fall outside `compaction.keepRecentTokens` before it invokes extension
hooks. The footer's context count also includes context that is not represented by those entries, such as the system prompt
and tool definitions. As a result, `/compact` can report `Nothing to compact (session too small)` even after the displayed
context crosses the compaction threshold; the selected compaction model is not called in this case.

Lower Pi's retained-history budget when this occurs, then run `/reload` before retrying `/compact`:

```json
{
  "compaction": {
    "keepRecentTokens": 8000
  }
}
```

The appropriate value depends on the session and desired retained history. Pi's default is `20000`.

### Curated Pi packages

- **BTW** — [`@juicesharp/rpiv-btw`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-btw) adds
  `/btw <question>`, which asks the active model a side question without adding the exchange to the main transcript.
- **Ask User Question** —
  [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
  adds the `ask_user_question` tool, which gives the model a structured interactive questionnaire. English is available
  without the optional rpiv i18n package.
- **Subagents** — [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) adds the `Agent`,
  `get_subagent_result`, and `steer_subagent` tools for foreground and background delegation, plus `/agents` for managing
  agent definitions, running agents, concurrency, scheduling, and other settings.
- **Web Access** — [`pi-web-access`](https://github.com/nicobailon/pi-web-access) adds `web_search`, `fetch_content`, and
  `get_search_content` tools for web research, URL and PDF extraction, GitHub repositories, and video content. It works
  without an API key using Exa MCP, with optional support for additional search providers.

All four packages are pinned and bundled into `pi-suite`, so `pi install npm:pi-suite` loads them together with the
compaction feature. The suite exposes only the Web Access extension; it does not register `pi-web-access`'s optional
Librarian skill. Pi Suite's Librarian below is an independently curated subagent preset instead.

Use **Setup agents** in `/suite` once to install Pi Suite's read-only `Explore`, `Librarian`, and `Oracle` subagents
globally:

- **Explore** provides finder-style behavior and concept discovery, chained searches, call-path tracing, and cross-module
  correlation in an isolated context. It returns concise findings with file and line evidence. Pi should use its direct
  read, grep, and find tools instead for known paths, symbols, and exact strings, and can launch multiple `Explore` agents
  in parallel for independent discovery questions. It is pinned to GPT-5.6 Terra with low thinking.
- **Librarian** provides Amp-style external source-code research for repositories outside the local workspace. Use it to
  understand upstream dependencies, locate feature implementations, compare patterns across projects, trace code history,
  or inspect public and `gh`-authenticated private GitHub repositories. It uses Web Access to locate and fetch authoritative
  sources, clones repositories into `/tmp/pi-github-repos/<owner>/<repo>`, then uses read-only local and Git inspection for
  fast, complete lookups. It returns a full evidence-backed answer with immutable source links and is pinned to GPT-5.6 Sol
  with thinking off.
- **Oracle** provides an independent expert second opinion for tricky reviews, subtle bugs, architecture or design
  tradeoffs, and complex implementation plans. Brief it with one focused question, the intent, relevant files or git refs,
  constraints, risks or alternatives to assess, and the desired output. It advises only; the parent agent remains
  responsible for applying and verifying recommendations. It can retrieve current external evidence with the bundled Web
  Access tools, delegate focused local repository discovery to the read-only `Explore` type, and delegate authoritative
  external source-code research to `Librarian`. It is pinned to GPT-5.6 Sol with high thinking.

The command writes to `$PI_CODING_AGENT_DIR/agents` (normally `~/.pi/agent/agents`), preserves existing customized
definitions, and disables the upstream default agents in favor of suite and user definitions. Run `/reload` afterward.
Explore and Oracle disable skills; Librarian inherits available skills so authenticated repository-research workflows such
as Sourcegraph can complement Web Access. Explore exposes only read-oriented built-ins. Librarian loads only the Web Access
extension and selectively exposes `web_search`, `fetch_content`, and `get_search_content` alongside read-oriented built-ins;
its prompt requires non-interactive search and limits other Bash use to external clone inspection or read-only workflows
defined by loaded skills. Oracle uses Subagents' `disallowed_tools` denylist to structurally remove `edit` and `write`, and
selectively exposes Pi Suite's `oracle_finder` and `oracle_librarian` adapters plus the same Web Access tools; it
does not inherit other extension tools. Pi Suite registers both adapters only inside the Oracle child session, so they are
absent from the main Pi agent's tool schema. Each adapter hard-codes its one allowed child type rather than exposing generic
recursive delegation. Because all three presets retain Bash for repository inspection, their non-mutating shell policy is
prompt-enforced rather than sandboxed. See
[Adding a subagent type](docs/adding-subagent-types.md) when extending the suite's preset catalog.

## Install

From npm after publication:

```sh
pi install npm:pi-suite
```

Or install directly from a Git repository:

```sh
pi install git:github.com/Hopsken/pi-suite
```

Restart Pi after installation or run `/reload`, use **Setup agents** in `/suite` once, then run `/reload` again to use
`Explore`, `Librarian`, and `Oracle`. Use `/tools` to manage the active tool set, `/agents` to manage subagents, and `/suite`
to configure Pi Suite.

To install the curated packages piece by piece instead, use:

```sh
pi install npm:@juicesharp/rpiv-btw
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-web-access
```

Installing `pi-web-access` directly also loads its Librarian skill from the child package manifest. Do not install any child
package separately while `pi-suite` is active. Pi treats the aggregate and child as different package identities and may
load duplicate command or tool registrations from separate module roots.

## Development

Requires Node.js 22.19 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm build
```

Custom workflows live under `src/` and are registered through the single `src/index.ts` extension entry point so they can
share state, configuration, UI conventions, and lifecycle behavior. Third-party Pi packages must be added to both
`dependencies` and `bundleDependencies`, then their selected resources must be listed explicitly in the root `pi`
manifest. Pi does not automatically discover resources from transitive dependencies. See
[Bundling third-party Pi extensions](docs/bundling-pi-extensions.md) for the complete maintainer workflow and release
checks.

## License

MIT
