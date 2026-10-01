# Dictation

Fully local CPU inference behind `/ws/speech`.

- Audio lives in memory for one utterance, is never written to disk, and never
  leaves the machine.
- The recognizer needs the total sample count BEFORE any audio, so live partials
  are impossible with this model: buffer the whole utterance and decode once. Do
  not add a streaming-partials path without changing models.
- Decoder-level hotword biasing is unavailable for the shipped Parakeet model
  (verified, not assumed). Keep greedy decoding and fix jargon with the shared
  vocabulary rules, which apply in ONE pass inside `applySpeechVocabulary` —
  never fork a server-local copy, or the Settings preview starts lying.
- The per-utterance byte cap stays DERIVED from
  `maxUtteranceSeconds × sampleRate × 2`; a flat constant wrongly rejects a
  legitimate long utterance from a 48 kHz `AudioContext`.
- Speech frames are their own shared unions with their own validator: never
  route them through `validateClientMessage`.
- Dictation is NOT an agent turn: graceful shutdown rejects new utterances and
  lets the child go. The recognizer's ever-growing `--log-file` must never be
  routed into `DATA_DIR`.
- The browser holds the authoritative audio and retries over HTTP, so add no
  server-side utterance state that outlives a connection.
