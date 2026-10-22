# Speech

Fully local CPU inference for dictation and conversation.

- Audio stays in memory and on this machine. Offline dictation buffers one
  utterance; conversation forwards frames without keeping audio history.
- Parakeet offline dictation needs the total sample count before audio. Buffer
  and decode once on `/ws/speech`; keep its HTTP retry path unchanged. Live
  partials belong only to Nemotron on `/ws/speech/conversation`, gated on
  sherpa-onnx >= 1.13.5 because older versions drop streaming subwords.
- Decoder-level hotword biasing is unavailable for the shipped Parakeet model
  (verified, not assumed). Keep greedy decoding and fix jargon with the shared
  vocabulary rules, which apply in ONE pass inside `applySpeechVocabulary` —
  never fork a server-local copy, or the Settings preview starts lying.
- The per-utterance byte cap stays DERIVED from
  `maxUtteranceSeconds × sampleRate × 2`; a flat constant wrongly rejects a
  legitimate long utterance from a 48 kHz `AudioContext`.
- Speech frames are their own shared unions with their own validator: never
  route them through `validateClientMessage`.
- Speech is NOT an agent turn: graceful shutdown rejects new streams and lets
  the child go. The recognizer's ever-growing `--log-file` must never be routed
  into `DATA_DIR`.
- The browser holds the authoritative audio and retries over HTTP, so add no
  server-side utterance state that outlives a connection.
- The recognizer socket listens for `error` with `on`, never `once`: production
  Bun emits it twice for one refused connect, and the warm-up retries refusals
  by design, so an unheard second one crashes the whole server.
