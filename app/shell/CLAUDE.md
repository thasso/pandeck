<!-- instruction-budget: bytes=2816 reason="Native failure modes; shell-only recovery prevents reload loops, and origin trust must track the append-only runtime ACL." task=13 date=2026-08-18 -->

# Native shell

Rules for the Rust/Tauri shell (macOS and iOS) around the hosted `app/web`
build: it owns native capabilities, navigation policy, the menu and the
bootstrap page — never product UI.

- Declare every app command in `build.rs` and grant it per origin in
  `capabilities/`: hosted pages get the minimum, server-repointing ones stay
  bootstrap-only, a plugin reaches the page only through a command of ours. Keep
  grants in step with `config::is_allowed` and the labels `build_app_window`
  mints. Trust startup choices or successfully probed repoints; use the same
  process-local URLPatterns for navigation and IPC before persisting a choice.
- An app window loads the server URL DIRECTLY and stays hidden until it reports
  in. Only `window_loaded`, raised by the SHELL's init script, may decide
  recovery — never the app's `window_ready`, which an older deployment lacks.
  The bootstrap page is recovery only (`ready`'s deadlines, `Server…`), never
  the way in, and `background_throttling` stays disabled so a hidden window can
  report.
- `Info.plist` makes native capabilities exist; `plugins.deep-link.mobile` stops
  the plugin deleting its `CFBundleURLTypes` on iOS. Verify in a BUNDLED, SIGNED
  build on a REMOTE origin, never `tauri dev`.
- `gen/` is generated: the iOS `aps-environment` entitlement comes from
  `build.rs`, never an edit there.
- Desktop-only Tauri surface is `cfg(desktop)`, not merely unused: menu, extra
  windows, geometry, `inner_size` (tao sizes the `UIWindow` by it).
- Cover the iOS screen with `ios::cover_safe_area`, or CSS safe-area insets are
  zero.
- Route outside opens through `openurl::open_target` to ONE window. Retain
  targets until that window acknowledges navigation; events only wake the drain.
  Keep targets opaque under `TARGET_KEY`.
- The init script stamps `data-native-shell` and the chrome insets before first
  paint; the page detects the shell only through `lib/nativeShell.ts`, never an
  awaited path. On macOS the top bar IS the title bar: no page height for it,
  and `data-tauri-drag-region` on whatever covers it, never its children.
- Foreign links leave via opener; same-origin files use only the validated
  `open_served_file` command with token-free scoped grants. Init re-issues
  dropped `_blank` clicks. `on_new_window` answers `Create`, never `Allow`, with
  its OWN `WKUserContentController`, never an unverified window.
- Diagnostics stay debug-only; panic reports are not. `panic = "abort"` never
  returns: it makes the ObjC exceptions wry catches fatal, in shipped builds
  only.
