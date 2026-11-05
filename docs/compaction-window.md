# Compaction window

A session can store a **compaction window**: the context size, in tokens, at
which its harness compacts the conversation. With no value the provider's own
default applies, which is the behaviour sessions had before the window existed.
It exists because Claude sessions on 1M-window models otherwise compact only
near 1M, and every tool call re-reads the whole context (Task-946).

This document owns the contract. Task-969 adds an agent lowering its own window;
Task-970 adds spawn rows and the `AGENT.md` default.

## Storage

- `session_index.compaction_window` (migration `0094`), nullable, mapped to
  `SessionMeta.compactionWindow`. It is the DESIRED value.
- `session_index.compaction_window_note` (migration `0095`) maps to
  `SessionMeta.compactionWindowNote`. It explains creation-time clamping or a pi
  estimate-to-actual difference, survives restart, and lasts until the next
  window change. Forks do not copy the note.
- The only writer is
  `sessionStore.setCompactionWindow(id, tokens | null, note?)`. Its single
  UPDATE writes both columns, clearing the note when omitted. It throws when no
  live row changed, so a caller never applies a value it did not store. `upsert`
  never writes or clears the column.
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
- **Agent** (Task-969): the deferred, Build-only tool
  `session_compaction_window { tokens }`
  (`tools/sessions/sessionCompactionWindowTool.ts`). It acts only on the calling
  session, during a turn, and never clears. Checks, in order, each refusing
  before any effect:
  1. the provider reports compaction turned off;
  2. pi only: its applied state is `unknown` after a failed change;
  3. the value is at least the agent floor, 100 000, and within the range;
  4. it does not raise the window. Claude: below the window the current process
     runs with (its start value, or with none the reported threshold + 13 000),
     and below the stored value if there is one. pi: below the current trigger
     from pi's own resolver.

  Claude checks only against the RUNNING process. Its provider switch and
  running window must be known for that process: from a report it already sent,
  or from one summary `getContextUsage` read, bounded at 10 seconds. The reply
  itself must carry the switch, and, when compaction is on and the process
  started with no value, the threshold; other reports never complete it. With no
  running process, a failed or silent read, a reply short of those fields, or a
  process that changed while reading, it refuses with nothing stored. It never
  falls back to an earlier process's report.

  The result says when the value applies: Claude when the next process starts
  (normally the next turn), pi now. The stored value never authorizes an agent
  change and is never a rollback target.

- **Spawn**: a row value is agent-written, so initial validation requires the
  agent floor through the model's native trigger. The row overrides an
  `AGENT.md` `compactionWindow` default. A definition uses the user's range,
  clamped into it, or dropped with the reason when there is none. Claude can
  therefore raise a definition's 50,000 to its 100,000 floor.

  The propose card seals the request and shows the estimated value read-only. A
  smaller model re-pick clamps a row down, refusing only if its trigger is below
  100,000. pi estimates use the capability's `defaultReserve`, pinned by a test
  to pi's `DEFAULT_COMPACTION_SETTINGS.reserveTokens`. Initial row validation
  can refuse a value a smaller actual reserve would allow.

  After creation the setter reconciles against the actual range. pi never raises
  the request or a numeric estimate; an estimate of none is not a ceiling, so a
  definition can acquire a value when the actual range allows it. An explicit
  row whose actual trigger is below 100,000 is refused, never dropped and
  delivered. A definition drops only for an empty actual range. The setter
  atomically stores the actual value and a truthful note whenever it differs
  from the estimate, including none to a value. Still-true re-pick clamp notes
  carry an `On approval:` prefix; direct notes use `At creation:`. The result,
  resolved card and inspector show the same stored value and note.

  Storage precedes context and every delivery, including a held opener's
  enqueue. A refusal or save failure names the created session id and delivers
  no opener. A later start pass or restart has nothing to dispatch for it. First
  sends from the agent picker apply the creation-time definition default through
  the same setter, without an estimate or ceiling, before sending the first
  prompt. Resume never reapplies defaults.

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

  An idle retained process closes immediately when a stored start-time setting
  needs a restart, including a window changed during its empty-host grace. It
  never closes for this reason during a turn, compaction, a pending Stop, or
  active background work. Last-task completion, turn completion, compaction
  completion and Stop acknowledgement reconsider the close. With no pending
  restart, including a value reverted to the epoch's effective start value, the
  frozen `claudeEmptyHostGraceMs` still applies. A missing provider task alone
  keeps that grace for terminal-notification reconciliation.

  A retained turn's Stop acknowledgement is bounded at four seconds, including
  queued-message drop answers. Every outstanding Stop on that epoch must settle;
  a newer acknowledgement cannot clear an older unanswered request. If one times
  out, the process is quarantined, not reused. Background work stays alive and
  its lifecycle evidence continues to drain, but prompts, provider turns and
  compaction cannot run on that process. All new native and MCP tool actions are
  refused by app-side admission, including ordinary file/shell tools and
  background launches. Native hooks check the calling epoch before admission and
  again after any asynchronous launch reservation. A refused, unexecuted
  reservation is released without stopping existing jobs. MCP calls carry their
  query epoch and recheck on the server immediately before the app tool
  executes, even if an earlier native hook allowed the call. Each query mounts
  its own MCP endpoint, so an old CLI connection cannot take a successor's
  executor. Read hooks also recheck after awaiting file metadata. Stale or
  closing epochs and tools racing an active Stop are refused too. A late
  acknowledgement does not lift quarantine. Once fully idle, the host retires
  through the supervisor, after normal frozen grace with no pending setting or
  immediately when a setting awaits restart. Only a fresh query after the old
  one terminates may accept the next prompt. After stream termination,
  retirement also releases the Worker engine without waiting forever for
  abandoned control answers. This is failed-Stop recovery, not a quiet close
  during an active Stop.

  Compaction waiting for Stop owns a reservation. Another Stop cancels it; after
  the wait it rechecks that exact reservation and query epoch before queuing
  `/compact`. Its cleanup cannot clear a successor's reservation.

  The restart decision belongs to the shared start-time-setting path in
  quiet-close scheduling, not a window-specific close path. Restart and resume
  start from the row. Once the old process starts closing, the inspector says
  "Applies on the next turn"; that turn starts a fresh process with the stored
  value.

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
  on a real `SettingsManager`. pi's `save()` also drops the separate in-memory
  retry-suppression override. No production path calls it today; this controller
  restores only the compaction window, not other SettingsManager overrides.

- Clearing writes back each touched model's underlying reserve. A model switch
  writes the window for the new model.
- `compaction.enabled: false` is never changed. The harness reports `disabled`
  and applies nothing.
- **Summary cost:** pi also sizes its compaction summaries from the reserve. A
  lower window means a larger reserve and longer, costlier summaries. The
  inspector says so beside the control.

## Inspector

The session inspector's Compaction window section shows:

- the stored value, or "Provider default", as a property trigger; an "Effective"
  row follows when a model clamps it;
- the range only when none is known (its reason); a known range sits at the
  editor slider's ends;
- the persisted creation-time note, when present;
- a Status row only while the value is not applied: "Applies on the next turn",
  "Applies once the session is idle", "Unknown after a failed change", or that
  compaction is turned off;
- a failed apply (pi only);
- "Compacts at about N tokens", N in short form (967k).

The trigger opens a popover editor: a slider over the range, Apply to save the
value it rests on, and Provider default to clear a set value. Each opening
starts from the stored value; an unapplied drag is dropped.

It sets and clears the value through
`setCompactionWindow { sessionId, tokens, requestId }`. An out-of-range value is
refused before sending, with the server's wording
(`compactionWindowUserRefusal`). A server refusal arrives as an `error` with the
request id and a session target, and is shown in place. Arrival announcements
keep their existing failure-home policy; a correlated refusal never populates or
stops the viewed chat's generic error/run state.

The client mutation lifecycle owns the request id and original 30-second
deadline. These are receipt-only records, with no list optimism, digest claim or
shell-cache block. The latest request per session alone can release its busy
receipt. Settle and refusal dispatch that release immediately, without a 0 ms
release timer; timeout says "The server did not answer. Try again." An
authoritative state update is not a receipt.

Genuine connected loss releases busy with a local unknown marker, silently.
Repeated failed connection attempts leave queued-unsent set/clear receipts and
their original deadlines intact. Reconnect's normal session authority decides
what landed; recovery adds no read, replay or rollback. Teardown abandons these
correlations and timers.

The slider cannot leave the range, so the inspector keeps no draft across a
send: an unknown receipt releases busy and the next opening reads the stored
value. This local unknown is not the provider's `applied: unknown` state.

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

Task-969's agent path ran live on 2026-10-20, same SDK, Opus 5.5, an unbound
session with nothing stored, through the real tool and setter:

- On its first turn, `session_compaction_window { tokens: 150000 }` read the
  running process mid-turn (threshold 967 000) and stored 150 000 in about 50
  ms, pending `process-restart`; the turn finished normally.
- The next turn's process started with 150 000 ("Applied"); its threshold was
  117 000.
- A later call with 200 000 was refused: the largest acceptable was 149 999.
