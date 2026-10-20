# Compaction window

A session can store a **compaction window**: the context size, in tokens, at
which its harness compacts the conversation. With no value the provider's own
default applies, which is the behaviour sessions had before the window existed.
It exists because Claude sessions on 1M-window models otherwise compact only
near 1M, and every tool call re-reads the whole context (Task-946).

This document owns the contract. Task-969 (an agent lowering its own window) and
Task-970 (spawn rows and the `AGENT.md` field) build on it.

## Storage

- `session_index.compaction_window` (migration `0094`), nullable, mapped to
  `SessionMeta.compactionWindow`. It is the DESIRED value.
- The only writer is `sessionStore.setCompactionWindow(id, tokens | null)`. It
  throws when no live row changed, so a caller never applies a value it did not
  store. `upsert` never writes or clears the column.
- Every source goes through one setter,
  `setSessionCompactionWindow(sessionId, tokens, actor)` in
  `app/server/src/sessionCompactionWindow.ts`. Calls for one session run one at
  a time. It never opens a harness.
- After a change, the live session broadcasts its state, and every connection
  showing the session DETACHED resends its state (`hub.sessionStateChanged`).
  All three state producers (Claude, pi, `ViewSession`) read the row fresh.

## Ranges

`HarnessDescriptor.compactionWindow` (`app/shared/harnesses.ts`) declares the
capability. App code branches on it, never on a harness id.
`compactionWindowRange` in `app/shared/compactionWindow.ts` computes the user's
range:

| Harness | Mapping   | User range                                                           |
| ------- | --------- | -------------------------------------------------------------------- |
| Claude  | `window`  | 100 000 … min(model window, 1 000 000), the CLI's schema and clamp   |
| pi      | `reserve` | 1 … native trigger, where native trigger = model window − pi reserve |

- An empty range makes the control unavailable and shows the reason.
- A stored value outside a later model's range is kept. The harness clamps it
  when it starts, and the inspector shows the effective value beside it.
- Without an open harness, ranges come from the stored model's window and, for
  pi, pi's default reserve (`DEFAULT_COMPACTION_SETTINGS`). The open harness
  re-checks with the session's real settings.

## Who may set it

- **User** (the inspector): any value in the range, or clear. The value is
  stored first, then handed to the live harness.
- **Agent** (Task-969; no caller yet): only its own running session, never a
  clear. Checks, in order, each refusing before any effect:
  1. the provider reports compaction turned off;
  2. pi only: its applied state is `unknown` after a failed change;
  3. the value is at least the agent floor, 100 000, and within the range;
  4. it does not raise the window. Claude: below the window the current or last
     process runs with (its start value, or with none the reported threshold +
     13 000), and below the stored value if there is one. With no report of the
     running window it refuses. pi: below the current trigger from pi's own
     resolver.

  The stored value never authorizes an agent change and is never a rollback
  target.

- **Spawn** (Task-970): a row value is agent-written, so it must be between the
  agent floor and the model's native trigger. A definition default is clamped
  into the range, or dropped with the reason when there is none.
- **Fork**: the child copies the parent's stored value verbatim
  (`inheritCompactionWindow`) and its harness applies it. Failover keeps the
  row.

## Claude

- A query starts with
  `settings: { ...CLAUDE_SDK_HARNESS_SETTINGS, autoCompactWindow }` when a value
  is stored. It then also drops `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from the
  environment, because the CLI reads that variable before any settings. With
  nothing stored, settings and environment are exactly as before. This includes
  an unbound session that inherits the server's variable. One-shot and usage
  queries never take a window, and `idleCompaction` is never set.
- **A running process keeps the window it started with.** The CLI fixes the
  window when a query starts. `applyFlagSettings({ autoCompactWindow })` is
  accepted on a running process, but it changes neither the reported threshold
  nor when the process compacts. So Pandeck sends nothing live:
  - in an idle session, the value applies when the next turn starts, because
    ordinary turns close their process;
  - during a turn, or while background work keeps the process open, it applies
    when that process restarts.

  Restart and resume start from the row.

- Applied state is per query epoch. It is `confirmed` while the value the epoch
  started with equals the stored one (clamped). Otherwise it is `pending` with
  `process-restart`, or with `next-turn` when no process runs.
- The provider trigger shown is the CLI's last reported `autoCompactThreshold`
  for the current or last process. It is labelled separately from the window:
  the CLI compacts about 33 000 tokens below the window.

## pi

- pi compacts when the context passes the model's window minus its reserve. It
  reads `compaction.modelOverrides["provider/id"]` first, so the window is
  written there as that model's reserve:
  `contextWindow − clamp(window, 1, nativeTrigger)`. The write goes through
  `applyOverrides` on the session's OWN `SettingsManager`, in memory only and
  never to disk. It takes effect before the next model call, so pi applies a
  change live.
- Every real settings rebuild drops in-memory overrides. The controller
  (`piSdk/compactionWindow.ts`) wraps the instance's four rebuild methods (pi
  1.1.0):
  - `reload`;
  - `save`;
  - `saveProjectSettings`;
  - `setProjectTrusted`, only when trust actually changes.

  After each real rebuild it re-reads the underlying reserve and re-applies. A
  pi upgrade that changes that set needs the controller revisited; its tests run
  on a real `SettingsManager`.

- Clearing writes back each touched model's underlying reserve. A model switch
  writes the window for the new model.
- `compaction.enabled: false` is never changed. The harness reports `disabled`
  and applies nothing.
- **Summary cost:** pi also sizes its compaction summaries from the reserve. A
  lower window means a larger reserve and longer, costlier summaries. The
  inspector says so beside the control.

## Inspector

The session inspector's Compaction window section shows:

- the stored value, or "Provider default", with the effective value when a model
  clamps it;
- the range;
- when the value applies: "Applied", "Applies when the next turn starts", or
  "Applies when this process restarts";
- a failed apply (pi only);
- "Compacts at about N tokens".

It sets and clears the value through
`setCompactionWindow { sessionId, tokens, requestId }`. An out-of-range value is
refused before sending, with the server's wording
(`compactionWindowUserRefusal`). A server refusal arrives as an `error` with the
request id and a session target, and is shown in place.

## Evidence

AC1.8 ran live on 2026-10-20: agent SDK 0.3.296, Opus 5.5 with a 1M window, the
real `ClaudeSdkSession` on the real SDK seam.

| Case                                     | Start setting | Threshold | Outcome                               |
| ---------------------------------------- | ------------- | --------- | ------------------------------------- |
| No window                                | none          | 967 000   |                                       |
| Next start, stored 100 000               | 100 000       | 67 000    | `maxTokens` 100 000                   |
| `applyFlagSettings(100 000)` on retained | none          | 967 000   | no compaction up to 137 185 tokens    |
| Restart of that session, stored 100 000  | 100 000       | 67 000    | auto-compacted 137 456 → 1 999 tokens |

The start path, in-turn compaction and resume follow the window. The live path
does not. Revisit the live path when the SDK is upgraded.
