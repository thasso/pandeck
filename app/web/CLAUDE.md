# Web client

- Follow `app/web/docs/ui-shell.md` for any change to the app shell, sidebar,
  routing, or page composition.
- Route API and WebSocket calls through the existing `serverOrigin` helpers so
  auth token handling stays in one place.
- The Tauri shell loads this same build: native behavior is an enhancement
  behind `src/lib/nativeShell.ts`, ordinary browsers must work unchanged, and
  its overlay title bar reuses the desktop top bar and adds no page height.
- `window.confirm`/`alert`/`prompt` are banned (`nativeDialogAudit.test.ts`):
  the shell's webview never shows them, so the guarded action silently does
  nothing. Ask through `components/common/dialogs.tsx` — `useDialogs()` to ask
  then act, `ConfirmDialog` for a flow owning its own busy/error state.
- There is NO banner channel (`docs/messaging.md`, `messagingAudit.test.ts`): a
  failure belongs on its object (`ErrorNote`), an event whose surface is gone
  goes in a toast NAMING it, and only app-wide lifecycle state the user cannot
  act on announces itself, via `AppStatus`. Success is silent unless the
  confirmation is the only outcome or the message carries an action. An
  announcement is raised where the message ARRIVES, never derived from state; a
  surface rendering a failure in place claims it (`lib/messageArrival.ts`).
- Keep the `vite.config.ts` guard that forces `NODE_ENV=development` for
  `command === "serve"`: a dev server inheriting `NODE_ENV=production` loses the
  Fast Refresh preamble while the JSX transform still emits `$RefreshSig$()`,
  which renders a blank page.
- Keep `src/lib/pcm16Worklet.js` excluded from `build.assetsInlineLimit` —
  `audioWorklet.addModule()` does not reliably accept a `data:` URL. Verify
  worklet-style assets in a real production build, not in dev.
- Keep Vite chunks under the 500 KB budget; the lazy Shiki grammar/wasm chunks
  have the only allowance.
