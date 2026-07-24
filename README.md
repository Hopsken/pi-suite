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

#### Compaction model

The package adds `/compaction-model`, which selects a dedicated model and thinking level for session compaction without
changing the active conversation model.

The selection is stored in Pi's global `settings.json` under `piSuite.compactionModel`, so it persists across new and
resumed sessions. Choose **Use active session model (default)** to reset it.

Compaction continues to use Pi's native implementation, including its prompts, structured summaries, cut-point and recent
message retention, split-turn handling, iterative summaries, file-operation tracking, and `/compact` instructions. If the
selected model disappears, cannot authenticate, or fails, Pi falls back to the active session model.

Only authenticated models are shown. The searchable picker matches provider names, model IDs, and human-readable model
names. The thinking-level picker is limited to levels supported by the selected model.

> Pi currently authenticates the active conversation model before running compaction hooks. The active model therefore
> still needs valid authentication even when a dedicated compaction model is selected.

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
- **Web Access** — [`pi-web-access`](https://github.com/nicobailon/pi-web-access) adds `web_search`, `fetch_content`, and
  `get_search_content` tools for web research, URL and PDF extraction, GitHub repositories, and video content. It works
  without an API key using Exa MCP, with optional support for additional search providers.

All three packages are pinned and bundled into `pi-suite`, so `pi install npm:pi-suite` loads them together with the
compaction feature. The suite exposes only the Web Access extension; it does not register `pi-web-access`'s optional
Librarian skill.

## Install

From npm after publication:

```sh
pi install npm:pi-suite
```

Or install directly from a Git repository:

```sh
pi install git:github.com/Hopsken/pi-suite
```

Restart Pi after installation or run `/reload`, then use `/compaction-model`.

To install the curated packages piece by piece instead, use:

```sh
pi install npm:@juicesharp/rpiv-btw
pi install npm:@juicesharp/rpiv-ask-user-question
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
