# Server speech implementation reference

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

- Offline Parakeet needs the total sample count before audio. Its path still
  buffers the whole utterance and decodes once. Streaming Nemotron uses a
  separate protocol and process described below.
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

## Streaming conversation STT

`streamingSttConfig.ts` discovers the online binary and streaming-only models.
The startup version probe uses the spawn broker, has a five-second budget, and
fails closed below sherpa-onnx 1.13.5 or when the version cannot be verified. No
model is loaded at startup. Status stays synchronous using that cached probe;
the lazy engine checks the same gate before spawning.

`streamingSttEngine.ts` owns one additional warm model child, not the offline
engine. Concurrent starts share one warm-up, readiness uses a real WebSocket
handshake, and two live streams are allowed. Each holds the child against idle
shutdown. Each pending open has a cancellation signal: cancel/disconnect
releases admission immediately during runtime discovery, backoff, readiness or
connection. An abandoned open never connects when shared warm-up later finishes.
The warm model can still serve a new start; without holds its idle timer also
applies while warming. Configuration generations prevent superseded starts from
spawning, marking readiness or stopping their replacement. Failure backs off
five seconds; disposal rejects pending opens immediately and prevents late
spawn/connection. Direct model-child spawn is the narrow server rule exception
for PID-held lifetime control and SIGKILL escalation. Default inference uses
four threads and greedy decoding. Sherpa endpoint rules 1 and 2 both explicitly
use the configured silence duration, with zero minimum segment length. Rule 1
includes all-silence segments; rule 2 requires speech. Rule 3 is an intentional
exception to the pause threshold: it forces a final segment at 120 seconds even
without silence. M3 auto-sends that forced final as a spoken turn, just like an
ordinary endpoint. All rule flags are explicit so upstream defaults cannot
shorten a configured pause. The process log stays outside DATA_DIR.

`streamingSttClient.ts` translates browser Int16 LE into 16 kHz Float32 LE,
without the offline header. Sherpa JSON updates contain `text`, `segment`, and
`is_final`. `Done` drains the stream, `Done!` finishes it. If the final drained
update is not marked final, it is promoted before `stopped`. The socket keeps an
`on` error listener for Bun's duplicate-error behavior. Pending finish has a
ten-second deadline. Socket backpressure is bounded; it never retains audio
history.

`conversationSocket.ts` is the separate browser trust boundary at
`/ws/speech/conversation`, behind the same token/origin and shutdown checks as
other app sockets. Its shared unions never enter `validateClientMessage` or the
offline validator. The protocol is:

1. Browser sends `{ type: "start" }`, then waits for
   `{ type: "accepted", sampleRate: 16000 }` before sending audio.
2. Binary frames contain mono Int16 LE at 16 kHz, at most one second per frame.
   Capture must resample on the client. Server forwarding is immediate. A token
   bucket refills at real time and holds at most ten seconds of audio, including
   after quiet keepalives. Its cap rounds the shared
   `SPEECH_SEND_WATERMARK_BYTES` send backlog up to whole seconds, then adds one
   maximum frame. The browser's 256 KiB watermark is about 8.2 seconds at 16 kHz
   Int16, so an allowed backlog can flush without a rate rejection. The browser
   checks the watermark before sending and stops conversation if it is reached;
   the extra frame covers the last send crossing it. A monotonic clock measures
   refill time. Missing audio for 30 seconds closes the stream.
3. `{ type: "transcript", segment, text, isFinal }` replaces that segment's
   text. The vocabulary engine runs on both partial and final text. A final
   segment is the browser's auto-send signal; empty segments do not send a turn.
4. `{ type: "stop" }` drains remaining text and answers `{ type: "stopped" }`.
   `{ type: "cancel" }` discards the connection immediately, without a final
   transcript. Disconnect also cancels, including a start still warming up.

A new start after `stopped` begins fresh segment numbering. Stale callbacks
cannot affect a later stream. A protocol or recognizer failure sends `error` and
closes the browser socket. No audio is written to disk, no HTTP retry exists for
this path, and no per-utterance state outlives the connection.

## Kokoro synthesis

`ttsConfig.ts` probes the configured Python's sherpa_onnx import at startup
through the broker, and discovers the complete model directory from
`ASSISTANT_TTS_MODEL_DIR` or the dev slot `DATA_DIR/models/tts/kokoro-v1-fp32`.
The committed `config/tts-models.json` is shared by Nix and
`pnpm run tts:model`. Status is independent of streaming/offline STT and user
enablement, under `ready.speechToText.tts` and `speechToTextStatus.status.tts`.

`ttsEngine.ts` owns one lazy warm Python child, loaded with eight CPU threads by
default, one active sentence, and no queued work. A competing request gets 429.
The engine waits for graph initialization's `ready` frame, bounds warm-up to 60
seconds and generation to 30 seconds, backs off five seconds after a crash, and
unloads after the configured idle interval. Thread changes terminate and wait
for the old child before spawning another. Disposal rejects warm-up and active
work. A failed termination escalates to SIGKILL after five seconds; no
replacement spawns before exit. Warm model spawn uses the server's narrow
PID-control exception, not per-request process spawning.

`kokoroSidecar.py` uses the fp32 Kokoro model, English lexicon, espeak data and
dictionaries, with `lang=en-us`. Its reader thread accepts newline-delimited
JSON requests, each at most 8192 bytes:

- `{type: "synthesize", id, text, sid, speed}`
- `{type: "cancel", id}`

The main thread alone calls `generate`. Cancellation sets an event read by the
generation callback. If the callback stalls, Node terminates the child after two
seconds. A successful cancellation acknowledges without unloading the model.
Responses have a four-byte unsigned little-endian JSON-header length, then UTF-8
JSON, then the declared PCM bytes for `audio` only:

- `{type: "ready"}` after load and graph warm-up.
- `{type: "audio", id, sampleRate: 24000, bytes}` plus mono PCM16 LE.
- `{type: "cancelled", id}` or `{type: "error", id}`.

`ttsProtocol.ts` bounds headers to 4096 bytes and PCM to 30 seconds. Arbitrary
pipe chunk boundaries and coalesced frames are supported. Native stderr is
drained without retaining input-bearing diagnostics; stdout is protocol only. No
audio file or utterance/session record is created.

`ttsHttp.ts` implements `POST /api/speech/synthesize` behind the existing API
token/origin gate. Send `Content-Type: application/json` and
`{text, voice?, speed?}`. Text must be nonblank and at most 500 JavaScript
characters; the body is capped at 8192 bytes. Split longer prose in the client.
Voice is a name from shared `KOKORO_ENGLISH_VOICES`, whose explicit ids come
from the pinned sherpa-onnx Kokoro v1.0 generator. Optional voice/speed override
settings only for that request, enabling unsaved previews. Speed is 0.5 to 2.
Unknown fields, including model paths, are rejected. The response is mono PCM16
WAV at 24 kHz with no-store caching. Error codes are 400 for validation, 403 for
the user switch, 405 for method, 413 for body size, 415 for media type, 429 for
busy and 503 for unavailable inference. Request disconnect/response close aborts
synthesis. A 95-second request deadline also bounds body reads. M3 must abort
the current fetch on barge-in and clear local queued playback; the server
retains no conversation utterance state.

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
