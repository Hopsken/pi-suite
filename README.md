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

Curated third-party packages will be documented here as they are added. They are pinned and bundled into the published
`pi-suite` artifact so one `pi install` provides the complete distribution.

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

## Development

Requires Node.js 22.19 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm build
```

Custom workflows live under `src/` and are registered through the single `src/index.ts` extension entry point so they can
share state, configuration, UI conventions, and lifecycle behavior. Third-party Pi packages must be added to both
`dependencies` and `bundledDependencies`, then their selected resources must be listed explicitly in the root `pi`
manifest. Pi does not automatically discover resources from transitive dependencies.

## License

MIT
