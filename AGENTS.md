# Pi Suite product principle

Pi Suite is an opinionated, one-stop product for Pi extensions. Users should not need to understand or manage each bundled
extension's settings. The normal upgrade path is: update the `pi-suite` package, then run `/reload` in Pi.

- Own dependency configuration, compatibility changes, preset updates, and settings migrations in Suite.
- Do not make routine upgrades depend on manual configuration edits or rerunning Setup agents.
- Apply required migrations before the affected extension loads. Make them versioned and repeat-safe so later reloads
  preserve subsequent user choices.
- Preserve unrelated settings and user data. Back up custom files before replacement and report migration failures.
- Expose intentional user choices through `/suite`; keep dependency configuration out of the normal workflow.
- Verify upgrades from existing installations as well as clean installs, including repeated reloads and failure recovery.
