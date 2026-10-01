# Server dictation — implementation reference

Relocated from `app/server/src/speech/CLAUDE.md` (Task-274) so it stops costing
agent context on every visit. This is a descriptive snapshot of what the modules
in that subtree own; the rules an agent must not violate stay in that folder's
`CLAUDE.md`. Correct or delete a section here when the code moves on. Relative
paths in the body are relative to the original subtree.

## Purpose

Composer dictation on the server: the `/ws/speech` audio boundary, the warm
local speech-recognition process, model/binary resolution, and post-decode text
repair. Fully local inference on CPU — no speech data leaves the machine.

## Module ownership

- `sttConfig.ts` owns discovery and the availability projection. Dictation is an
  optional HOST capability — the NixOS module deploys no recognizer and no
  weights — so everything here is discovery, and `ASSISTANT_STT_DISABLED` is
  checked FIRST and beats all of it: a PR preview cannot rely on the recognizer
  being absent from a host where the binary is found by a PATH lookup.
  Resolution order is `ASSISTANT_STT_MODELS` (a JSON `catalog id -> dir` map) +
  `speechToText.modelId` → `ASSISTANT_STT_MODEL_DIR` (single-dir override, what
  the module sets from `speech.modelDir`) → `DATA_DIR/models/stt/<id>/` (dev
  fallback slot, populated by `pnpm run stt:model`); the binary comes from
  `ASSISTANT_STT_SERVER_BIN` or a PATH lookup. The model _catalog_ is the
  committed `config/stt-models.json`, shared with `flake.nix` and the dev script
  so a URL/hash is never written twice. A directory counts as installed ONLY
  when every file the catalog entry names is present, and
  `describeSttAvailability` must name the paths it searched — an unexplained
  disabled mic button is the failure mode this prevents.
- `sttEngine.ts` owns the single warm recognizer child process: lazy background
  spawn as soon as recording starts (before the complete utterance is
  submitted), readiness by retrying the real handshake (`connectSttWhenReady`),
  a single-flight decode queue (one model instance), recording-held warm-up
  reservations that prevent idle release while a user is speaking, idle
  shutdown, restart backoff, and `dispose()` for graceful shutdown.
- `sttClient.ts` owns the recognizer's own WebSocket framing: an 8-byte
  `int32le sampleRate` + `int32le payloadByteLength` header, then float32
  samples in chunks, then one JSON reply frame; the connection is reusable
  across utterances.
- `speechSocket.ts` owns the browser-facing trust boundary:
  `validateSpeechClientMessage`, the per-connection utterance state machine
  (optional `warm` → `start` → binary Int16LE PCM frames → `stop`/`cancel`), its
  recording-held warm-up reservation, Int16→float conversion, the derived buffer
  cap, and transcript finalization. A cold model is never reported to the
  browser: recording and streaming proceed regardless, the load overlaps them,
  and `stop` simply waits for it — so there is no `warming` frame and no client
  warm-up state to leave stuck on screen.
- Post-decode `spoken → written` rewrites are applied here
  (`finalizeTranscript`) but the engine itself is `@assistant/shared`'s
  `applySpeechVocabulary`, so the Settings editor can preview with the same
  code. Do not fork a server-local copy.

## Contract notes and rationale

- The recognizer needs the total sample count BEFORE any audio, so live partial
  results are impossible with this model: buffer the whole utterance and decode
  once. Do not add a streaming-partials path without changing models.
- Decoder-level hotword biasing is unavailable for the shipped Parakeet model
  (`--hotwords-file` needs `--modeling-unit=bpe`, which needs a `--bpe-vocab`
  the archive does not ship; with the default unit the flag is silently inert).
  Keep greedy decoding and fix jargon with the shared vocabulary rules, authored
  in Settings → Dictation. Verified, not assumed — re-verify before revisiting.
- Vocabulary rules apply in ONE pass (enforced in the shared engine). Sequential
  application lets a later rule rewrite text an earlier rule just produced.
- The per-utterance byte cap must stay DERIVED from
  `maxUtteranceSeconds × sampleRate × 2`. A flat constant wrongly rejects a
  legitimate 120 s utterance from a 48 kHz `AudioContext` (11.5 MB), which is
  what Safari hands us.
- Never treat this socket's traffic as a session protocol message: speech frames
  are their own shared unions and their own validator, keeping
  `validateClientMessage`'s exhaustive registry untouched.
- Dictation is NOT an agent turn. Graceful shutdown must not wait for it —
  reject new utterances and let the child go, so no stray process is left for
  `ExecStop`'s cgroup sweep.
- The recognizer's `--log-file` records connect/disconnect lines only (no
  transcripts) but appends forever, so it defaults outside `DATA_DIR`. Never
  route it into the backed-up data directory. Do NOT wait for startup with a
  bare TCP/port probe: a connection that dies before the WebSocket handshake
  makes the recognizer log
  `[error] handle_read_handshake error: … (End of File)` on every single start,
  which is misleading noise in the one log worth checking when dictation is
  actually broken. Retrying the real handshake is refused by the kernel while
  nothing listens, so it never reaches the recognizer at all.
- Audio lives in memory for the duration of one utterance and is never written
  to disk.

## Working notes

- Measured on the deploy box (Ryzen 9 3900X, CPU-only, int8 Parakeet TDT 0.6B
  v2): ~0.05× realtime decode (3 s → ~185 ms, 30 s → ~1.55 s), ~2 s model load,
  ~1.9 GB resident warm (~2.6 GB after a long utterance). Those numbers are why
  warm-up begins at recording start and the process is then idle-stopped; keep
  both properties if you touch the lifecycle.
- The browser holds the authoritative copy of the audio and retries through
  `POST /api/speech/transcribe`, so this layer deliberately has no resume
  protocol, no acks, and no partial-buffer retention. Do not add server-side
  utterance state that outlives a connection.

## Verification commands

- Run `pnpm --filter @assistant/server test` (unit tests cover framing,
  validation, caps, vocabulary, and the resolution chain; none of them need a
  model).
- A real decode needs a model: `pnpm run stt:model`, then exercise `/ws/speech`.
