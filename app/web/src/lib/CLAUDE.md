# Web client library

- Keep helpers framework-free; pure transforms stay apart from browser wrappers.
- `historyNav.ts` owns every history write. Document entries carry origin and
  one coalesced outer-viewer scroll offset; flush it before navigation/unmount
  so Close/traversal preserve origin, Forward and position.
- Only `nativeShell.ts` knows Tauri exists; detect its root attribute
  synchronously and use typed helpers. Same-origin external files pass only
  scoped token-free grants to its narrow opener, else fail closed. Outside opens
  register before draining, serialize drains, and acknowledge after navigation.
- Exactly ONE runtime raises a socket `appNotification`, and
  `apnsPush.shouldRaiseAppNotification` is the only answer: two buzz twice, none
  is silence (`docs/notifications.md`).
- Dictated audio and transcripts stay client-side: `recentTranscripts.ts` is
  `localStorage` and per-device, and the server persists no transcripts. Moving
  either server-side changes where dictated text lives.
- `pcm16Worklet.js` runs on the audio thread and must stay allocation-light: it
  frames ~200 ms per message and decimates to 16 kHz only by an exact integer
  factor, passing other rates through for the server to resample. Never resample
  at a non-integer ratio here.
- `speechCapture.ts` keeps every frame as the authoritative utterance and feeds
  the socket only under the `bufferedAmount` watermark. The microphone stream
  and `AudioContext` are PARKED (tracks disabled, context suspended) between
  utterances, bounded by page-hide/idle release and skipped where the permission
  grant is remembered (including in the native shell) — do not go back to
  stopping them per utterance, and acquire the `AudioContext` BEFORE
  `getUserMedia` so the user gesture is not spent on the permission prompt.
- The screen wake lock is held only while recording and every failure path
  degrades silently: it may never fail a recording.
