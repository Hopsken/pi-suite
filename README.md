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

The selection is stored as branch-aware session metadata, so it survives session resumes and follows the selected branch
when navigating the session tree. Choose **Use active session model (default)** to reset it.

Compaction continues to use Pi's native implementation, including its prompts, structured summaries, cut-point and recent
message retention, split-turn handling, iterative summaries, file-operation tracking, and `/compact` instructions. If the
selected model disappears, cannot authenticate, or fails, Pi falls back to the active session model.

Only authenticated models are shown. The thinking-level picker is limited to levels supported by the selected model.

> Pi currently authenticates the active conversation model before running compaction hooks. The active model therefore
> still needs valid authentication even when a dedicated compaction model is selected.

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
