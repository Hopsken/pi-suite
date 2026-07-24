# Bundling third-party Pi extensions

`pi-suite` is a one-install Pi package. Third-party extensions included in the suite must be declared, physically bundled,
and explicitly exposed by the root package. Adding a package to `dependencies` alone is not enough because Pi does not
recursively discover resources from dependency manifests.

## How the package wiring works

Every included extension has three entries in the root `package.json`:

1. `dependencies` selects the package version and makes its runtime dependency tree available.
2. `bundleDependencies` puts that package inside the published `pi-suite` tarball under `node_modules/`.
3. `pi.extensions` tells Pi which bundled entry point to load.

For example:

```json
{
  "pi": {
    "extensions": [
      "./src/index.ts",
      "./node_modules/@scope/example-extension/index.ts"
    ]
  },
  "dependencies": {
    "@scope/example-extension": "1.2.3"
  },
  "bundleDependencies": [
    "@scope/example-extension"
  ]
}
```

Use the `bundleDependencies` spelling. `bundledDependencies` is a deprecated alias.

Bundling is different from compiling. The extension remains its own package; its published files are copied into the
`pi-suite` tarball. The package-relative path in `pi.extensions` therefore exists after `pi install npm:pi-suite`, even when
the installer's normal dependency layout would otherwise hoist packages.

## Adding an extension

### 1. Inspect the candidate package

Before changing `pi-suite`:

- Review the extension source because Pi extensions execute with full system access.
- Inspect the exact published version's `package.json`, not only its repository checkout.
- Find its `pi.extensions` entries and confirm those files are included by its `files` or published tarball.
- Check its Pi peer dependency ranges against the versions used to develop and test `pi-suite`.
- Check for command, shortcut, tool, and event behavior that could conflict with existing suite features.
- Decide whether optional peers should remain optional or become separately included suite packages.

Pin included packages to exact versions so a new upstream release cannot silently change the suite:

```sh
pnpm add --save-exact @scope/example-extension@1.2.3
```

### 2. Add all three manifest entries

Edit the root `package.json`:

1. Keep the exact version under `dependencies`.
2. Add the same package name to `bundleDependencies`.
3. Add each desired extension entry point to `pi.extensions`, prefixed with
   `./node_modules/<package-name>/`.

Mirror only the resources the suite intends to expose. If a child package declares several extensions, it is valid to
include only a selected subset.

Do not also import or re-export the child extension from `src/index.ts`. Loading it from both locations would register its
commands or tools twice.

### 3. Keep Pi host libraries as peers

Do not add Pi host packages such as these to the suite's `bundleDependencies`:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

They are supplied by Pi and belong in the suite's `peerDependencies`. Bundling another copy can create duplicate runtime
instances and break extension integration. Also review how a candidate extension declares these packages; if it carries one
as an ordinary dependency, bundling the extension may carry that dependency with it. Resolve any compatibility concern
before inclusion rather than adding another direct copy to the suite.

A child extension's ordinary non-peer runtime dependencies are pulled into its bundle as needed. They do not need separate
`pi.extensions` entries unless they are themselves resources the suite intends Pi to load.

### 4. Update the lockfile and documentation

Commit both `package.json` and `pnpm-lock.yaml`. Add the extension to the README's **Curated Pi packages** section, including
its user-visible commands or tools and an upstream source link.

Warn users not to install the child package separately while `pi-suite` is active. Pi treats the aggregate package and a
separately installed child as different package identities, which can produce duplicate registrations.

## Verification

Run the normal repository checks from a clean dependency graph:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Then inspect the publish artifact. Testing only from the repository is insufficient because the local `node_modules` can
hide missing bundle configuration:

```sh
pnpm pack --dry-run --json \
  | rg 'node_modules/@scope/example-extension/(package.json|index.ts)'
```

Adjust the final filename in that expression to match every entry listed in `pi.extensions`. Each entry point and the child
package's `package.json` must appear in the output.

For a stronger release check, create the tarball and inspect it directly:

```sh
pack_dir="$(mktemp -d)"
pnpm pack --pack-destination "$pack_dir"
tar -tf "$pack_dir"/pi-suite-*.tgz \
  | rg 'package/node_modules/@scope/example-extension/(package.json|index.ts)'
rm -rf "$pack_dir"
```

Finally, install the tarball in a clean environment, start Pi, and verify that the new command or tool is registered exactly
once and that the existing suite extensions still load.

## Common mistakes

- **Only adding `dependencies`:** the package may be installed, but Pi will not recursively load its `pi` manifest.
- **Only adding `pi.extensions`:** the path may work in a development checkout but be absent from the published tarball.
- **Using `bundledDependencies`:** this is the deprecated spelling; use `bundleDependencies`.
- **Bundling Pi host packages:** this can load incompatible duplicate framework instances.
- **Depending on an optional peer implicitly:** optional peers are not included unless the suite adds and wires them
  deliberately.
- **Testing only the source tree:** always inspect the packed artifact, which is what users receive.
- **Installing both aggregate and child packages:** this can register the same command or tool twice.

## Current examples

The root manifest currently applies this pattern to:

- `@juicesharp/rpiv-btw`
- `@juicesharp/rpiv-ask-user-question`
- `pi-web-access` (extension entry point only; its Librarian skill is not exposed)

Use those entries as the executable reference when adding the next extension.
