# Vendored `alwith-drive` 0.6.2

## Source

The published crates.io crate `alwith-drive` 0.6.2. Archive SHA-256:

```
46b0494acbec387fda470c48fe8a55c9b105875ea046001bc9c80a7b217649eb
```

`src/`, `build.rs`, `permissions/`, both licence files and `Cargo.toml.orig` are
the upstream bytes unchanged. Registry metadata (`.cargo-ok`) and the crate's own
development `Cargo.lock` are omitted; this application owns dependency resolution.

## Only difference

`Cargo.toml`, two version requirements, nothing else:

| dependency       | upstream         | here                  |
| ---------------- | ---------------- | --------------------- |
| `specta`         | `2.0.0-rc.28`    | `=2.0.0-rc.27`        |
| `tauri3-specta`  | `0.1.0-alpha.5`  | `=0.1.0-alpha.4`      |

Features, every other dependency, and all of `src/` stay exactly as published —
`diff -r vendor/alwith-drive/src ~/.cargo/registry/src/*/alwith-drive-0.6.2/src`
is empty.

Why: `@alwith/api` depends on `specta-typescript 0.0.14`, which pins
`specta =2.0.0-rc.27`. Cargo cannot keep two pre-releases of the same base
version, and a caret range on `specta-typescript 0.0.x` cannot reach 0.0.15. Upstream
`alwith-drive` 0.6.0 shipped the exact same `client.rs` / `lib.rs` / `types.rs`
against rc.27 + alpha.4; 0.6.2 only adds the `setExcluded` and `resolveConflict`
contract variants, so its sources demonstrably build on rc.27.

0.6.0 itself is not an option: the Drive settings "library participates in sync"
switch sends `setExcluded` before `pin`, and 0.6.0 has neither.

## Removal condition

Delete this directory, drop the `[patch.crates-io] alwith-drive` entry and change
the dependency back to `alwith-drive = "0.6.2"` once the whole application's specta
stack moves to rc.28 — i.e. when `@alwith/api`'s `specta-typescript` no longer pins
`=2.0.0-rc.27`.
